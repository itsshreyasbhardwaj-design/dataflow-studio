import { createHash } from "node:crypto";
import type { Expr, SqlValue } from "./ast.js";
import { exprToString } from "./ast.js";

export class SqlEvaluationError extends Error {
  readonly errorClass = "validation";
  constructor(message: string) {
    super(message);
    this.name = "SqlEvaluationError";
  }
}

export interface EvalRow {
  /** Both `column` and `table.column` keys. */
  values: Record<string, unknown>;
  /** Unqualified names that exist in more than one input, so must be qualified. */
  ambiguous: ReadonlySet<string>;
}

export interface EvalContext {
  row?: EvalRow;
  /** Pre-computed aggregate values, keyed by `exprToString`. */
  aggregates?: ReadonlyMap<string, unknown>;
  /** Fixed clock so that `now()` is stable within a single query. */
  now: Date;
}

export const EMPTY_ROW: EvalRow = { values: {}, ambiguous: new Set() };

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.getTime();
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Three-valued comparison. Returns null when either side is NULL, which is what
 * makes `WHERE amount > 0` skip NULL rows instead of throwing.
 */
export function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date || b instanceof Date) {
    const na = a instanceof Date ? a.getTime() : toNumber(a) ?? Date.parse(String(a));
    const nb = b instanceof Date ? b.getTime() : toNumber(b) ?? Date.parse(String(b));
    return Math.sign(na - nb);
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    return Math.sign((a ? 1 : 0) - (b ? 1 : 0));
  }
  if (isNumeric(a) && isNumeric(b)) {
    return Math.sign(toNumber(a)! - toNumber(b)!);
  }
  const sa = toText(a)!;
  const sb = toText(b)!;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** SQL truthiness: only TRUE passes a WHERE clause. */
export function isTrue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|t|yes|y|1)$/i.test(value);
  return Boolean(value);
}

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "%") source += "[\\s\\S]*";
    else if (char === "_") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source + "$", caseInsensitive ? "i" : "");
}

export function evaluate(expr: Expr, context: EvalContext): unknown {
  // An aggregate is resolved from the pre-computed group results, never recomputed.
  if (context.aggregates) {
    const key = exprToString(expr);
    if (context.aggregates.has(key)) return context.aggregates.get(key);
  }

  switch (expr.kind) {
    case "literal":
      return expr.value;

    case "star":
      throw new SqlEvaluationError("`*` is only valid in a select list or as COUNT(*)");

    case "column": {
      const row = context.row ?? EMPTY_ROW;
      if (expr.table) {
        const key = `${expr.table}.${expr.name}`;
        if (!(key in row.values)) {
          throw new SqlEvaluationError(`Unknown column "${key}"`);
        }
        return row.values[key];
      }
      if (row.ambiguous.has(expr.name)) {
        throw new SqlEvaluationError(`Column reference "${expr.name}" is ambiguous; qualify it with a table name`);
      }
      if (!(expr.name in row.values)) {
        throw new SqlEvaluationError(`Unknown column "${expr.name}"`);
      }
      return row.values[expr.name];
    }

    case "unary": {
      if (expr.op === "NOT") {
        const value = evaluate(expr.expr, context);
        if (value === null || value === undefined) return null;
        return !isTrue(value);
      }
      const n = toNumber(evaluate(expr.expr, context));
      return n === null ? null : -n;
    }

    case "binary":
      return evaluateBinary(expr, context);

    case "isNull": {
      const value = evaluate(expr.expr, context);
      const isNull = value === null || value === undefined;
      return expr.negated ? !isNull : isNull;
    }

    case "in": {
      const value = evaluate(expr.expr, context);
      if (value === null || value === undefined) return null;
      let sawNull = false;
      for (const candidate of expr.list) {
        const other = evaluate(candidate, context);
        if (other === null || other === undefined) { sawNull = true; continue; }
        if (compareValues(value, other) === 0) return !expr.negated;
      }
      // `x NOT IN (1, NULL)` is UNKNOWN, not TRUE.
      if (sawNull) return null;
      return expr.negated;
    }

    case "between": {
      const value = evaluate(expr.expr, context);
      const low = compareValues(value, evaluate(expr.low, context));
      const high = compareValues(value, evaluate(expr.high, context));
      if (low === null || high === null) return null;
      const within = low >= 0 && high <= 0;
      return expr.negated ? !within : within;
    }

    case "like": {
      const value = evaluate(expr.expr, context);
      const pattern = evaluate(expr.pattern, context);
      if (value === null || value === undefined || pattern === null || pattern === undefined) return null;
      const matched = likeToRegExp(String(pattern), expr.caseInsensitive).test(String(value));
      return expr.negated ? !matched : matched;
    }

    case "cast":
      return castValue(evaluate(expr.expr, context), expr.to);

    case "case": {
      if (expr.operand !== undefined) {
        const operand = evaluate(expr.operand, context);
        for (const branch of expr.whens) {
          if (compareValues(operand, evaluate(branch.when, context)) === 0) return evaluate(branch.then, context);
        }
      } else {
        for (const branch of expr.whens) {
          if (isTrue(evaluate(branch.when, context))) return evaluate(branch.then, context);
        }
      }
      return expr.else !== undefined ? evaluate(expr.else, context) : null;
    }

    case "function":
      return callScalarFunction(expr.name, expr.args.map((a) => evaluate(a, context)), context, expr);
  }
}

function evaluateBinary(expr: Extract<Expr, { kind: "binary" }>, context: EvalContext): unknown {
  switch (expr.op) {
    case "AND": {
      const left = evaluate(expr.left, context);
      // Short-circuit on FALSE, which also lets `false AND (1/0)` stay safe.
      if (left !== null && left !== undefined && !isTrue(left)) return false;
      const right = evaluate(expr.right, context);
      if (right !== null && right !== undefined && !isTrue(right)) return false;
      if (left === null || left === undefined || right === null || right === undefined) return null;
      return true;
    }
    case "OR": {
      const left = evaluate(expr.left, context);
      if (left !== null && left !== undefined && isTrue(left)) return true;
      const right = evaluate(expr.right, context);
      if (right !== null && right !== undefined && isTrue(right)) return true;
      if (left === null || left === undefined || right === null || right === undefined) return null;
      return false;
    }
    case "=": case "<>": case "<": case "<=": case ">": case ">=": {
      const cmp = compareValues(evaluate(expr.left, context), evaluate(expr.right, context));
      if (cmp === null) return null;
      switch (expr.op) {
        case "=": return cmp === 0;
        case "<>": return cmp !== 0;
        case "<": return cmp < 0;
        case "<=": return cmp <= 0;
        case ">": return cmp > 0;
        default: return cmp >= 0;
      }
    }
    case "||": {
      const left = toText(evaluate(expr.left, context));
      const right = toText(evaluate(expr.right, context));
      if (left === null || right === null) return null;
      return left + right;
    }
    default: {
      const left = toNumber(evaluate(expr.left, context));
      const right = toNumber(evaluate(expr.right, context));
      if (left === null || right === null) return null;
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/":
          // SQL raises on division by zero; returning NULL would hide broken data.
          if (right === 0) throw new SqlEvaluationError("Division by zero");
          return left / right;
        case "%":
          if (right === 0) throw new SqlEvaluationError("Division by zero");
          return left % right;
        default:
          throw new SqlEvaluationError(`Unsupported operator "${expr.op}"`);
      }
    }
  }
}

export function castValue(value: unknown, to: string): unknown {
  if (value === null || value === undefined) return null;
  const target = to.toLowerCase();
  switch (target) {
    case "int": case "int4": case "int8": case "integer": case "bigint": case "smallint": {
      const n = toNumber(value);
      return n === null ? null : Math.trunc(n);
    }
    case "float": case "float8": case "double": case "real": case "numeric": case "decimal":
      return toNumber(value);
    case "text": case "varchar": case "char": case "string":
      return toText(value);
    case "bool": case "boolean":
      return isTrue(value);
    case "date": {
      const text = toText(value);
      if (!text) return null;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
    }
    case "timestamp": case "timestamptz": {
      const text = toText(value);
      if (!text) return null;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    case "json": case "jsonb":
      if (typeof value === "object") return value;
      try { return JSON.parse(String(value)); } catch { return value; }
    default:
      throw new SqlEvaluationError(`Unsupported CAST target type "${to}"`);
  }
}

export const SCALAR_FUNCTIONS = new Set([
  "COALESCE", "NULLIF", "LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM", "LENGTH", "SUBSTR", "SUBSTRING",
  "REPLACE", "CONCAT", "CONCAT_WS", "SPLIT_PART", "ABS", "ROUND", "FLOOR", "CEIL", "CEILING", "MOD",
  "POWER", "SQRT", "GREATEST", "LEAST", "NOW", "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATE_TRUNC",
  "MD5", "LEFT", "RIGHT", "POSITION", "SIGN",
]);

function callScalarFunction(
  rawName: string,
  args: unknown[],
  context: EvalContext,
  expr: Extract<Expr, { kind: "function" }>,
): unknown {
  const name = rawName.toUpperCase();
  const arity = (min: number, max = min): void => {
    if (args.length < min || args.length > max) {
      throw new SqlEvaluationError(
        `${name} expects ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`,
      );
    }
  };
  const num = (index: number): number | null => toNumber(args[index]);
  const text = (index: number): string | null => toText(args[index]);

  switch (name) {
    case "COALESCE":
      arity(1, 64);
      return args.find((a) => a !== null && a !== undefined) ?? null;
    case "NULLIF":
      arity(2);
      return compareValues(args[0], args[1]) === 0 ? null : args[0] ?? null;
    case "LOWER": arity(1); return text(0)?.toLowerCase() ?? null;
    case "UPPER": arity(1); return text(0)?.toUpperCase() ?? null;
    case "TRIM": arity(1); return text(0)?.trim() ?? null;
    case "LTRIM": arity(1); return text(0)?.replace(/^\s+/, "") ?? null;
    case "RTRIM": arity(1); return text(0)?.replace(/\s+$/, "") ?? null;
    case "LENGTH": arity(1); return text(0)?.length ?? null;
    case "SUBSTR": case "SUBSTRING": {
      arity(2, 3);
      const source = text(0);
      const start = num(1);
      if (source === null || start === null) return null;
      const from = Math.max(0, start - 1);
      const count = args.length === 3 ? num(2) : undefined;
      return count === undefined || count === null ? source.slice(from) : source.slice(from, from + count);
    }
    case "LEFT": { arity(2); const s = text(0); const n = num(1); return s === null || n === null ? null : s.slice(0, Math.max(0, n)); }
    case "RIGHT": { arity(2); const s = text(0); const n = num(1); return s === null || n === null ? null : (n <= 0 ? "" : s.slice(-n)); }
    case "REPLACE": {
      arity(3);
      const source = text(0), search = text(1), replacement = text(2);
      if (source === null || search === null || replacement === null) return null;
      return source.split(search).join(replacement);
    }
    case "CONCAT":
      // PostgreSQL's CONCAT ignores NULLs rather than poisoning the result.
      return args.map((a) => (a === null || a === undefined ? "" : toText(a))).join("");
    case "CONCAT_WS": {
      arity(2, 64);
      const separator = text(0) ?? "";
      return args.slice(1).filter((a) => a !== null && a !== undefined).map((a) => toText(a)).join(separator);
    }
    case "SPLIT_PART": {
      arity(3);
      const source = text(0), delimiter = text(1), position = num(2);
      if (source === null || delimiter === null || position === null) return null;
      return source.split(delimiter)[position - 1] ?? "";
    }
    // POSITION(needle, haystack) -> 1-based index, 0 when absent.
    case "POSITION": { arity(2); const needle = text(0), haystack = text(1); return needle === null || haystack === null ? null : haystack.indexOf(needle) + 1; }
    case "ABS": { arity(1); const n = num(0); return n === null ? null : Math.abs(n); }
    case "SIGN": { arity(1); const n = num(0); return n === null ? null : Math.sign(n); }
    case "ROUND": {
      arity(1, 2);
      const n = num(0);
      if (n === null) return null;
      const digits = args.length === 2 ? num(1) ?? 0 : 0;
      const factor = 10 ** digits;
      // Round half away from zero, matching SQL numeric rounding.
      const rounded = Math.sign(n) * Math.round(Math.abs(n) * factor + Number.EPSILON) / factor;
      return digits > 0 ? Number(rounded.toFixed(Math.min(digits, 15))) : rounded;
    }
    case "FLOOR": { arity(1); const n = num(0); return n === null ? null : Math.floor(n); }
    case "CEIL": case "CEILING": { arity(1); const n = num(0); return n === null ? null : Math.ceil(n); }
    case "MOD": {
      arity(2);
      const a = num(0), b = num(1);
      if (a === null || b === null) return null;
      if (b === 0) throw new SqlEvaluationError("Division by zero");
      return a % b;
    }
    case "POWER": { arity(2); const a = num(0), b = num(1); return a === null || b === null ? null : a ** b; }
    case "SQRT": {
      arity(1);
      const n = num(0);
      if (n === null) return null;
      if (n < 0) throw new SqlEvaluationError("SQRT of a negative number");
      return Math.sqrt(n);
    }
    case "GREATEST": case "LEAST": {
      arity(1, 64);
      const defined = args.filter((a) => a !== null && a !== undefined);
      if (!defined.length) return null;
      return defined.reduce((best, candidate) => {
        const cmp = compareValues(candidate, best) ?? 0;
        return (name === "GREATEST" ? cmp > 0 : cmp < 0) ? candidate : best;
      });
    }
    case "NOW": case "CURRENT_TIMESTAMP": arity(0); return context.now.toISOString();
    case "CURRENT_DATE": arity(0); return context.now.toISOString().slice(0, 10);
    case "DATE_TRUNC": {
      arity(2);
      const unit = text(0)?.toLowerCase();
      const source = text(1);
      if (!unit || source === null) return null;
      const date = new Date(source);
      if (Number.isNaN(date.getTime())) return null;
      const parts = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
      const keep = { year: 1, quarter: 2, month: 2, week: 3, day: 3, hour: 4, minute: 5, second: 6 }[unit];
      if (keep === undefined) throw new SqlEvaluationError(`Unsupported DATE_TRUNC unit "${unit}"`);
      const truncated = [parts[0]!, keep > 1 ? parts[1]! : 0, keep > 2 ? parts[2]! : 1, keep > 3 ? parts[3]! : 0, keep > 4 ? parts[4]! : 0, keep > 5 ? parts[5]! : 0];
      if (unit === "quarter") truncated[1] = Math.floor(parts[1]! / 3) * 3, truncated[2] = 1;
      const result = new Date(Date.UTC(truncated[0]!, truncated[1]!, truncated[2]!, truncated[3]!, truncated[4]!, truncated[5]!));
      if (unit === "week") result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
      return result.toISOString();
    }
    case "MD5": { arity(1); const s = text(0); return s === null ? null : createHash("md5").update(s).digest("hex"); }
    default:
      throw new SqlEvaluationError(
        `Unknown function "${rawName}". Supported: ${[...SCALAR_FUNCTIONS].sort().join(", ")}` +
        (expr.distinct ? " (DISTINCT is only valid for aggregates)" : ""),
      );
  }
}

export { toNumber, toText };
export type { SqlValue };
