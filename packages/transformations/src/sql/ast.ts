export type SqlValue = string | number | boolean | null;

export type Expr =
  | { kind: "column"; table?: string; name: string }
  | { kind: "star"; table?: string }
  | { kind: "literal"; value: SqlValue }
  | { kind: "unary"; op: "-" | "NOT"; expr: Expr }
  | { kind: "binary"; op: BinaryOperator; left: Expr; right: Expr }
  | { kind: "isNull"; expr: Expr; negated: boolean }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "between"; expr: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean; caseInsensitive: boolean }
  | { kind: "case"; operand?: Expr; whens: Array<{ when: Expr; then: Expr }>; else?: Expr }
  | { kind: "cast"; expr: Expr; to: string }
  | { kind: "function"; name: string; args: Expr[]; distinct: boolean };

export type BinaryOperator =
  | "+" | "-" | "*" | "/" | "%" | "||"
  | "=" | "<>" | "<" | "<=" | ">" | ">="
  | "AND" | "OR";

export interface SelectColumn {
  expr: Expr;
  alias?: string;
}

export type JoinType = "inner" | "left" | "right" | "full" | "cross";

export interface TableRef {
  name: string;
  alias?: string;
}

export interface JoinClause {
  type: JoinType;
  table: TableRef;
  on?: Expr;
  using?: string[];
}

export interface OrderTerm {
  expr: Expr;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}

export interface SelectStatement {
  distinct: boolean;
  columns: SelectColumn[];
  from?: TableRef;
  joins: JoinClause[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: OrderTerm[];
  limit?: number;
  offset?: number;
}

export const AGGREGATE_FUNCTIONS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX", "STRING_AGG", "COUNT_DISTINCT"]);

export function isAggregate(expr: Expr): boolean {
  switch (expr.kind) {
    case "function":
      return AGGREGATE_FUNCTIONS.has(expr.name.toUpperCase()) || expr.args.some(isAggregate);
    case "unary":
      return isAggregate(expr.expr);
    case "binary":
      return isAggregate(expr.left) || isAggregate(expr.right);
    case "isNull":
      return isAggregate(expr.expr);
    case "in":
      return isAggregate(expr.expr) || expr.list.some(isAggregate);
    case "between":
      return isAggregate(expr.expr) || isAggregate(expr.low) || isAggregate(expr.high);
    case "like":
      return isAggregate(expr.expr) || isAggregate(expr.pattern);
    case "cast":
      return isAggregate(expr.expr);
    case "case":
      return (
        (expr.operand ? isAggregate(expr.operand) : false) ||
        expr.whens.some((w) => isAggregate(w.when) || isAggregate(w.then)) ||
        (expr.else ? isAggregate(expr.else) : false)
      );
    default:
      return false;
  }
}

/** Stable string form, used to key aggregate results and to name output columns. */
export function exprToString(expr: Expr): string {
  switch (expr.kind) {
    case "column": return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case "star": return expr.table ? `${expr.table}.*` : "*";
    case "literal": return expr.value === null ? "NULL" : typeof expr.value === "string" ? `'${expr.value}'` : String(expr.value);
    case "unary": return expr.op === "NOT" ? `NOT ${exprToString(expr.expr)}` : `-${exprToString(expr.expr)}`;
    case "binary": return `(${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)})`;
    case "isNull": return `${exprToString(expr.expr)} IS ${expr.negated ? "NOT " : ""}NULL`;
    case "in": return `${exprToString(expr.expr)}${expr.negated ? " NOT" : ""} IN (${expr.list.map(exprToString).join(", ")})`;
    case "between": return `${exprToString(expr.expr)}${expr.negated ? " NOT" : ""} BETWEEN ${exprToString(expr.low)} AND ${exprToString(expr.high)}`;
    case "like": return `${exprToString(expr.expr)}${expr.negated ? " NOT" : ""} ${expr.caseInsensitive ? "ILIKE" : "LIKE"} ${exprToString(expr.pattern)}`;
    case "cast": return `CAST(${exprToString(expr.expr)} AS ${expr.to})`;
    case "case":
      return [
        "CASE",
        expr.operand ? exprToString(expr.operand) : null,
        ...expr.whens.map((w) => `WHEN ${exprToString(w.when)} THEN ${exprToString(w.then)}`),
        expr.else ? `ELSE ${exprToString(expr.else)}` : null,
        "END",
      ].filter(Boolean).join(" ");
    case "function":
      return `${expr.name.toLowerCase()}(${expr.distinct ? "DISTINCT " : ""}${expr.args.map(exprToString).join(", ")})`;
  }
}

/** Default output column name, mirroring PostgreSQL's behaviour closely enough. */
export function defaultColumnName(column: SelectColumn, position: number): string {
  if (column.alias) return column.alias;
  if (column.expr.kind === "column") return column.expr.name;
  if (column.expr.kind === "function") return column.expr.name.toLowerCase();
  return `column${position + 1}`;
}

/** Every column referenced by an expression, for lineage and validation. */
export function collectColumns(expr: Expr, out: Array<{ table?: string; name: string }> = []): Array<{ table?: string; name: string }> {
  switch (expr.kind) {
    case "column": out.push({ ...(expr.table ? { table: expr.table } : {}), name: expr.name }); break;
    case "unary": case "cast": case "isNull": collectColumns(expr.expr, out); break;
    case "binary": collectColumns(expr.left, out); collectColumns(expr.right, out); break;
    case "in": collectColumns(expr.expr, out); expr.list.forEach((e) => collectColumns(e, out)); break;
    case "between": collectColumns(expr.expr, out); collectColumns(expr.low, out); collectColumns(expr.high, out); break;
    case "like": collectColumns(expr.expr, out); collectColumns(expr.pattern, out); break;
    case "function": expr.args.forEach((e) => collectColumns(e, out)); break;
    case "case":
      if (expr.operand) collectColumns(expr.operand, out);
      expr.whens.forEach((w) => { collectColumns(w.when, out); collectColumns(w.then, out); });
      if (expr.else) collectColumns(expr.else, out);
      break;
    default: break;
  }
  return out;
}
