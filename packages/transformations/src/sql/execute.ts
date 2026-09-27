import { inferSchema, makeBatch, type ColumnSchema, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import {
  AGGREGATE_FUNCTIONS, collectColumns, defaultColumnName, exprToString, isAggregate,
  type Expr, type JoinClause, type SelectStatement,
} from "./ast.js";
import { compareValues, evaluate, isTrue, SqlEvaluationError, toNumber, toText, type EvalRow } from "./evaluate.js";
import { parseSelect } from "./parser.js";

export interface QueryInputs {
  [table: string]: DataBatch;
}

export interface ExecuteOptions {
  /** Hard cap on result rows. Prevents one node from exhausting worker memory. */
  maxOutputRows?: number;
  /** Cap on the intermediate cross product of a non-equi join. */
  maxJoinRows?: number;
  now?: Date;
}

const DEFAULT_MAX_OUTPUT_ROWS = 1_000_000;
const DEFAULT_MAX_JOIN_ROWS = 10_000_000;

export class SqlExecutionError extends Error {
  readonly errorClass = "validation";
  constructor(message: string) {
    super(message);
    this.name = "SqlExecutionError";
  }
}

interface WorkingRow {
  eval: EvalRow;
}

function resolveTable(inputs: QueryInputs, name: string): DataBatch {
  if (inputs[name]) return inputs[name]!;
  const match = Object.keys(inputs).find((key) => key.toLowerCase() === name.toLowerCase());
  if (match) return inputs[match]!;
  throw new SqlExecutionError(
    `Unknown table "${name}". Available inputs: ${Object.keys(inputs).join(", ") || "(none)"}`,
  );
}

/** Builds the lookup map for one source row, holding both `col` and `alias.col`. */
function makeEvalRow(alias: string, row: Row, columns: readonly ColumnSchema[]): EvalRow {
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.name] ?? (column.name in row ? row[column.name] : null);
    values[column.name] = value === undefined ? null : value;
    values[`${alias}.${column.name}`] = values[column.name];
  }
  // Keys present in the row but absent from the declared schema still resolve.
  for (const [key, value] of Object.entries(row)) {
    if (!(key in values)) {
      values[key] = value;
      values[`${alias}.${key}`] = value;
    }
  }
  return { values, ambiguous: new Set() };
}

function mergeEvalRows(
  left: EvalRow | null,
  right: EvalRow | null,
  leftNames: ReadonlySet<string>,
  rightNames: ReadonlySet<string>,
  coalesced: ReadonlySet<string> = new Set(),
): EvalRow {
  const values: Record<string, unknown> = {};
  const ambiguous = new Set<string>(left?.ambiguous ?? []);
  for (const name of rightNames) {
    // A USING column is merged into one output column, so it is not ambiguous.
    if (leftNames.has(name) && !coalesced.has(name)) ambiguous.add(name);
  }
  if (left) Object.assign(values, left.values);
  else for (const key of leftNames) values[key] = null;

  if (right) {
    for (const [key, value] of Object.entries(right.values)) {
      // An unqualified collision keeps the left value, and referencing it
      // unqualified is an error (see `ambiguous`).
      if (key.includes(".") || !(key in values)) values[key] = value;
    }
  } else {
    for (const key of rightNames) if (!(key in values)) values[key] = null;
  }
  return { values, ambiguous };
}

function allKeys(rows: readonly WorkingRow[], alias: string, columns: readonly ColumnSchema[]): Set<string> {
  const keys = new Set<string>();
  for (const column of columns) {
    keys.add(column.name);
    keys.add(`${alias}.${column.name}`);
  }
  if (rows[0]) for (const key of Object.keys(rows[0].eval.values)) keys.add(key);
  return keys;
}

/**
 * Extracts `l.a = r.b AND l.c = r.d` conjunctions so we can hash-join instead of
 * walking the cross product. Sides are decided by which input can actually
 * resolve each column, not by guessing at alias names.
 */
function extractEquiKeys(
  on: Expr,
  leftKeys: ReadonlySet<string>,
  rightKeys: ReadonlySet<string>,
): Array<[Expr, Expr]> | null {
  const pairs: Array<[Expr, Expr]> = [];
  const sideOf = (expr: Expr): "left" | "right" | null => {
    const columns = collectColumns(expr);
    if (!columns.length) return null;
    let side: "left" | "right" | null = null;
    for (const column of columns) {
      const key = column.table ? `${column.table}.${column.name}` : column.name;
      const inLeft = leftKeys.has(key);
      const inRight = rightKeys.has(key);
      const resolved = inLeft && !inRight ? "left" : inRight && !inLeft ? "right" : null;
      if (resolved === null || (side !== null && side !== resolved)) return null;
      side = resolved;
    }
    return side;
  };
  const walk = (expr: Expr): boolean => {
    if (expr.kind === "binary" && expr.op === "AND") return walk(expr.left) && walk(expr.right);
    if (expr.kind === "binary" && expr.op === "=") {
      const a = sideOf(expr.left);
      const b = sideOf(expr.right);
      if (a === "left" && b === "right") { pairs.push([expr.left, expr.right]); return true; }
      if (a === "right" && b === "left") { pairs.push([expr.right, expr.left]); return true; }
      return false;
    }
    return false;
  };
  return walk(on) && pairs.length > 0 ? pairs : null;
}

function keyOf(values: unknown[]): string {
  return JSON.stringify(values.map((v) => (v === undefined ? null : v instanceof Date ? v.toISOString() : v)));
}

function applyJoin(
  leftRows: WorkingRow[],
  leftKeys: Set<string>,
  leftAliases: readonly string[],
  join: JoinClause,
  inputs: QueryInputs,
  options: Required<Pick<ExecuteOptions, "maxJoinRows">> & { now: Date },
): { rows: WorkingRow[]; keys: Set<string>; alias: string } {
  const batch = resolveTable(inputs, join.table.name);
  const alias = join.table.alias ?? join.table.name;
  const rightRows: WorkingRow[] = batch.rows.map((row) => ({ eval: makeEvalRow(alias, row, batch.columns) }));
  const rightKeys = allKeys(rightRows, alias, batch.columns);

  const merged: WorkingRow[] = [];
  const guard = (): void => {
    if (merged.length > options.maxJoinRows) {
      throw new SqlExecutionError(
        `Join produced more than ${options.maxJoinRows} rows; add a more selective join condition`,
      );
    }
  };

  if (join.type === "cross") {
    for (const left of leftRows) {
      for (const right of rightRows) {
        merged.push({ eval: mergeEvalRows(left.eval, right.eval, leftKeys, rightKeys) });
        guard();
      }
    }
    return { rows: merged, keys: new Set([...leftKeys, ...rightKeys]), alias };
  }

  const coalesced = new Set(join.using ?? []);
  const on: Expr | undefined = join.using
    ? join.using
        .map<Expr>((column) => {
          const owner = leftAliases.find((candidate) => leftKeys.has(`${candidate}.${column}`));
          if (!owner) {
            throw new SqlExecutionError(`USING column "${column}" is not present on the left side of the join`);
          }
          return {
            kind: "binary",
            op: "=",
            left: { kind: "column", table: owner, name: column },
            right: { kind: "column", table: alias, name: column },
          };
        })
        .reduce((acc, expr) => ({ kind: "binary", op: "AND", left: acc, right: expr }))
    : join.on;
  if (!on) throw new SqlExecutionError(`JOIN ${join.table.name} requires an ON or USING clause`);

  const matchedRight = new Set<number>();
  const equiKeys = extractEquiKeys(on, leftKeys, rightKeys);

  if (equiKeys) {
    // Hash join: build on the right, probe from the left.
    const buckets = new Map<string, number[]>();
    rightRows.forEach((row, index) => {
      const key = keyOf(equiKeys.map(([, rightExpr]) => evaluate(rightExpr, { row: row.eval, now: options.now })));
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    });

    for (const left of leftRows) {
      const key = keyOf(equiKeys.map(([leftExpr]) => evaluate(leftExpr, { row: left.eval, now: options.now })));
      const bucket = buckets.get(key);
      // NULL never matches in an equi-join.
      const nullKey = JSON.parse(key).some((v: unknown) => v === null);
      if (!nullKey && bucket?.length) {
        for (const index of bucket) {
          matchedRight.add(index);
          merged.push({ eval: mergeEvalRows(left.eval, rightRows[index]!.eval, leftKeys, rightKeys, coalesced) });
          guard();
        }
      } else if (join.type === "left" || join.type === "full") {
        merged.push({ eval: mergeEvalRows(left.eval, null, leftKeys, rightKeys, coalesced) });
        guard();
      }
    }
  } else {
    for (const left of leftRows) {
      let matched = false;
      for (let index = 0; index < rightRows.length; index++) {
        const candidate = mergeEvalRows(left.eval, rightRows[index]!.eval, leftKeys, rightKeys, coalesced);
        if (isTrue(evaluate(on, { row: candidate, now: options.now }))) {
          matched = true;
          matchedRight.add(index);
          merged.push({ eval: candidate });
          guard();
        }
      }
      if (!matched && (join.type === "left" || join.type === "full")) {
        merged.push({ eval: mergeEvalRows(left.eval, null, leftKeys, rightKeys, coalesced) });
        guard();
      }
    }
  }

  if (join.type === "right" || join.type === "full") {
    rightRows.forEach((row, index) => {
      if (!matchedRight.has(index)) {
        merged.push({ eval: mergeEvalRows(null, row.eval, leftKeys, rightKeys, coalesced) });
        guard();
      }
    });
  }

  return { rows: merged, keys: new Set([...leftKeys, ...rightKeys]), alias };
}

function computeAggregate(expr: Extract<Expr, { kind: "function" }>, rows: readonly WorkingRow[], now: Date): unknown {
  const name = expr.name.toUpperCase();
  const argExpr = expr.args[0];

  if (name === "COUNT") {
    if (!argExpr || argExpr.kind === "star") return rows.length;
    const values: unknown[] = rows
      .map((row) => evaluate(argExpr, { row: row.eval, now }))
      .filter((v) => v !== null && v !== undefined);
    if (expr.distinct) return new Set(values.map((v) => keyOf([v]))).size;
    return values.length;
  }

  if (!argExpr) throw new SqlEvaluationError(`${name} requires an argument`);
  let values: unknown[] = rows
    .map((row) => evaluate(argExpr, { row: row.eval, now }))
    .filter((v) => v !== null && v !== undefined);
  if (expr.distinct) {
    const seen = new Map<string, unknown>();
    for (const value of values) seen.set(keyOf([value]), value);
    values = [...seen.values()];
  }
  // Every aggregate over an all-NULL (or empty) input is NULL, including SUM.
  if (!values.length) return null;

  switch (name) {
    case "SUM": case "AVG": {
      let sum = 0;
      let count = 0;
      for (const value of values) {
        const n = toNumber(value);
        if (n === null) throw new SqlEvaluationError(`${name} received a non-numeric value: ${String(value)}`);
        sum += n;
        count++;
      }
      if (count === 0) return null;
      return name === "SUM" ? sum : sum / count;
    }
    case "MIN": case "MAX":
      return values.reduce((best, candidate) => {
        const cmp = compareValues(candidate, best) ?? 0;
        return (name === "MAX" ? cmp > 0 : cmp < 0) ? candidate : best;
      });
    case "STRING_AGG": {
      const separator = expr.args[1] ? toText(evaluate(expr.args[1], { row: rows[0]?.eval, now })) ?? "," : ",";
      return values.map((v) => toText(v)).join(separator);
    }
    default:
      throw new SqlEvaluationError(`Unsupported aggregate function "${expr.name}"`);
  }
}

function collectAggregates(expr: Expr, out: Array<Extract<Expr, { kind: "function" }>> = []): Array<Extract<Expr, { kind: "function" }>> {
  if (expr.kind === "function" && AGGREGATE_FUNCTIONS.has(expr.name.toUpperCase())) {
    out.push(expr);
    return out;
  }
  switch (expr.kind) {
    case "unary": case "cast": case "isNull": collectAggregates(expr.expr, out); break;
    case "binary": collectAggregates(expr.left, out); collectAggregates(expr.right, out); break;
    case "in": collectAggregates(expr.expr, out); expr.list.forEach((e) => collectAggregates(e, out)); break;
    case "between": collectAggregates(expr.expr, out); collectAggregates(expr.low, out); collectAggregates(expr.high, out); break;
    case "like": collectAggregates(expr.expr, out); collectAggregates(expr.pattern, out); break;
    case "function": expr.args.forEach((e) => collectAggregates(e, out)); break;
    case "case":
      if (expr.operand) collectAggregates(expr.operand, out);
      expr.whens.forEach((w) => { collectAggregates(w.when, out); collectAggregates(w.then, out); });
      if (expr.else) collectAggregates(expr.else, out);
      break;
    default: break;
  }
  return out;
}

/** Rejects `SELECT region, amount ... GROUP BY region`, as PostgreSQL does. */
function assertGroupingIsValid(statement: SelectStatement): void {
  if (!statement.groupBy.length) return;
  const grouped = new Set(statement.groupBy.map(exprToString));
  const covered = (expr: Expr): boolean => {
    if (grouped.has(exprToString(expr))) return true;
    if (isAggregate(expr)) return true;
    switch (expr.kind) {
      case "literal": return true;
      case "column": return false;
      case "star": return false;
      case "unary": case "cast": case "isNull": return covered(expr.expr);
      case "binary": return covered(expr.left) && covered(expr.right);
      case "in": return covered(expr.expr) && expr.list.every(covered);
      case "between": return covered(expr.expr) && covered(expr.low) && covered(expr.high);
      case "like": return covered(expr.expr) && covered(expr.pattern);
      case "function": return expr.args.every(covered);
      case "case":
        return (
          (expr.operand ? covered(expr.operand) : true) &&
          expr.whens.every((w) => covered(w.when) && covered(w.then)) &&
          (expr.else ? covered(expr.else) : true)
        );
    }
  };
  for (const column of statement.columns) {
    if (column.expr.kind === "star") {
      throw new SqlExecutionError("`SELECT *` cannot be combined with GROUP BY; list the grouped columns explicitly");
    }
    if (!covered(column.expr)) {
      throw new SqlExecutionError(
        `Column "${exprToString(column.expr)}" must appear in GROUP BY or be used in an aggregate function`,
      );
    }
  }
}

export function executeSelect(
  statement: SelectStatement,
  inputs: QueryInputs,
  options: ExecuteOptions = {},
): DataBatch {
  const now = options.now ?? new Date();
  const maxOutputRows = options.maxOutputRows ?? DEFAULT_MAX_OUTPUT_ROWS;
  const maxJoinRows = options.maxJoinRows ?? DEFAULT_MAX_JOIN_ROWS;

  // ---------------------------------------------------------------- FROM/JOIN
  let rows: WorkingRow[] = [];
  let keys = new Set<string>();
  let sourceColumns: ColumnSchema[] = [];
  const aliases: string[] = [];

  if (statement.from) {
    const batch = resolveTable(inputs, statement.from.name);
    const alias = statement.from.alias ?? statement.from.name;
    sourceColumns = batch.columns;
    rows = batch.rows.map((row) => ({ eval: makeEvalRow(alias, row, batch.columns) }));
    keys = allKeys(rows, alias, batch.columns);
    aliases.push(alias);
  } else {
    // `SELECT 1` with no FROM evaluates over a single empty row.
    rows = [{ eval: { values: {}, ambiguous: new Set() } }];
  }

  for (const join of statement.joins) {
    const result = applyJoin(rows, keys, aliases, join, inputs, { maxJoinRows, now });
    rows = result.rows;
    keys = result.keys;
    aliases.push(result.alias);
  }

  // -------------------------------------------------------------------- WHERE
  if (statement.where) {
    const predicate = statement.where;
    if (isAggregate(predicate)) {
      throw new SqlExecutionError("Aggregate functions are not allowed in WHERE; use HAVING instead");
    }
    rows = rows.filter((row) => isTrue(evaluate(predicate, { row: row.eval, now })));
  }

  // ------------------------------------------------------ GROUP BY/aggregates
  assertGroupingIsValid(statement);
  const aggregateExprs = [
    ...statement.columns.flatMap((c) => collectAggregates(c.expr)),
    ...(statement.having ? collectAggregates(statement.having) : []),
    ...statement.orderBy.flatMap((o) => collectAggregates(o.expr)),
  ];
  const isGrouped = statement.groupBy.length > 0 || aggregateExprs.length > 0;

  interface Group { representative: EvalRow; rows: WorkingRow[]; aggregates: Map<string, unknown> }
  let groups: Group[];

  if (!isGrouped) {
    groups = rows.map((row) => ({ representative: row.eval, rows: [row], aggregates: new Map() }));
  } else if (statement.groupBy.length === 0) {
    // A bare aggregate over zero rows still produces one row (COUNT(*) = 0).
    groups = [{ representative: rows[0]?.eval ?? { values: {}, ambiguous: new Set() }, rows, aggregates: new Map() }];
  } else {
    const byKey = new Map<string, Group>();
    for (const row of rows) {
      const key = keyOf(statement.groupBy.map((expr) => evaluate(expr, { row: row.eval, now })));
      const existing = byKey.get(key);
      if (existing) existing.rows.push(row);
      else byKey.set(key, { representative: row.eval, rows: [row], aggregates: new Map() });
    }
    groups = [...byKey.values()];
  }

  if (isGrouped) {
    for (const group of groups) {
      for (const expr of aggregateExprs) {
        const key = exprToString(expr);
        if (!group.aggregates.has(key)) {
          group.aggregates.set(key, computeAggregate(expr, group.rows, now));
        }
      }
    }
  }

  // ------------------------------------------------------------------- HAVING
  if (statement.having) {
    const having = statement.having;
    groups = groups.filter((group) =>
      isTrue(evaluate(having, { row: group.representative, aggregates: group.aggregates, now })),
    );
  }

  // ------------------------------------------------------------- ORDER BY key
  // Sort before projection so that ORDER BY can reference source columns that are
  // not in the select list.
  if (statement.orderBy.length) {
    // `ORDER BY revenue` may name a select-list alias rather than a source column.
    const byAlias = new Map<string, Expr>();
    for (const column of statement.columns) {
      if (column.alias) byAlias.set(column.alias, column.expr);
    }
    const terms = statement.orderBy.map((term) => {
      if (term.expr.kind === "column" && !term.expr.table) {
        const aliased = byAlias.get(term.expr.name);
        if (aliased && !(term.expr.name in (rows[0]?.eval.values ?? {}))) return { ...term, expr: aliased };
      }
      return term;
    });
    groups.sort((a, b) => {
      for (const term of terms) {
        const left = evaluate(term.expr, { row: a.representative, aggregates: a.aggregates, now });
        const right = evaluate(term.expr, { row: b.representative, aggregates: b.aggregates, now });
        const leftNull = left === null || left === undefined;
        const rightNull = right === null || right === undefined;
        if (leftNull || rightNull) {
          if (leftNull && rightNull) continue;
          const nullFirst = term.nulls === "first" ? -1 : 1;
          return leftNull ? nullFirst : -nullFirst;
        }
        const cmp = compareValues(left, right) ?? 0;
        if (cmp !== 0) return term.direction === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }

  // --------------------------------------------------------------- projection
  const outputNames: string[] = [];
  const projected: Row[] = [];

  for (const group of groups) {
    const row: Row = {};
    let position = 0;
    for (const column of statement.columns) {
      if (column.expr.kind === "star") {
        const prefix = column.expr.table ? `${column.expr.table}.` : null;
        const names = prefix
          ? Object.keys(group.representative.values).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
          : (sourceColumns.length && !statement.joins.length
              ? sourceColumns.map((c) => c.name)
              : Object.keys(group.representative.values).filter((k) => !k.includes(".")));
        for (const name of names) {
          const key = prefix ? `${prefix}${name}` : name;
          row[name] = group.representative.values[key] ?? null;
          if (!outputNames.includes(name)) outputNames.push(name);
        }
        position++;
        continue;
      }
      const name = defaultColumnName(column, position);
      row[name] = evaluate(column.expr, { row: group.representative, aggregates: group.aggregates, now }) ?? null;
      if (!outputNames.includes(name)) outputNames.push(name);
      position++;
    }
    projected.push(row);
  }

  // ------------------------------------------------------------------ DISTINCT
  let result = projected;
  if (statement.distinct) {
    const seen = new Set<string>();
    result = result.filter((row) => {
      const key = keyOf(outputNames.map((name) => row[name]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ------------------------------------------------------------ OFFSET/LIMIT
  const offset = statement.offset ?? 0;
  if (offset > 0) result = result.slice(offset);
  let truncated = false;
  const limit = statement.limit;
  if (limit !== undefined && result.length > limit) result = result.slice(0, limit);
  if (result.length > maxOutputRows) {
    result = result.slice(0, maxOutputRows);
    truncated = true;
  }

  const columns = inferSchema(result);
  // Preserve select-list order even for columns that were all NULL.
  const ordered: ColumnSchema[] = outputNames.map(
    (name) => columns.find((c) => c.name === name) ?? { name, type: "unknown", nullable: true },
  );

  return makeBatch(result, ordered, truncated ? { truncated: true } : {});
}

export function runQuery(sql: string, inputs: QueryInputs, options: ExecuteOptions = {}): DataBatch {
  return executeSelect(parseSelect(sql), inputs, options);
}
