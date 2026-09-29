import type { ColumnProfile, ColumnSchema, DataType, Row } from "./types.js";

const INTEGER = /^[+-]?\d{1,15}$/;
// Requires a decimal point or an exponent: a 20-digit run of digits is far more
// likely to be an identifier than a number, and silently turning it into a
// float would lose precision.
const FLOAT = /^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Type of a single value, before reconciliation across rows. */
export function inferValueType(value: unknown): DataType | "null" {
  if (value === null || value === undefined || value === "") return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "bigint") return "integer";
  if (value instanceof Date) return "timestamp";
  if (typeof value === "object") return "json";
  if (typeof value === "string") {
    if (TIMESTAMP.test(value)) return "timestamp";
    if (DATE.test(value)) return "date";
    if (INTEGER.test(value)) return "integer";
    if (FLOAT.test(value)) return "float";
    // Only treat literal true/false as boolean: "0"/"1"/"y" are too ambiguous
    // to infer without an explicit instruction from the user.
    if (/^(true|false)$/i.test(value)) return "boolean";
    return "string";
  }
  return "unknown";
}

/**
 * Reconciles two observed types into the narrowest type that can hold both.
 * The lattice is deliberately shallow: integer and float unify to float,
 * everything else unifies to string (or json if either side is json).
 */
export function unifyTypes(a: DataType, b: DataType): DataType {
  if (a === b) return a;
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  const pair = new Set([a, b]);
  if (pair.has("json")) return "json";
  if (pair.has("integer") && pair.has("float")) return "float";
  if (pair.has("date") && pair.has("timestamp")) return "timestamp";
  return "string";
}

export interface InferOptions {
  /** Rows scanned before inference stops. Keeps preview cheap on wide datasets. */
  sampleSize?: number;
  /** Extra string values treated as NULL, e.g. "\\N" from a Postgres COPY. */
  nullValues?: readonly string[];
}

export function inferSchema(rows: readonly Row[], options: InferOptions = {}): ColumnSchema[] {
  const limit = Math.min(rows.length, options.sampleSize ?? 1000);
  const nulls = new Set(options.nullValues ?? []);
  // Column order follows first appearance, which matches user expectations for
  // CSV and for `SELECT *`.
  const order: string[] = [];
  const types = new Map<string, DataType>();
  const nullable = new Map<string, boolean>();
  const present = new Map<string, number>();

  for (let i = 0; i < limit; i++) {
    const row = rows[i]!;
    for (const [key, raw] of Object.entries(row)) {
      if (!types.has(key)) {
        order.push(key);
        types.set(key, "unknown");
        nullable.set(key, false);
        present.set(key, 0);
      }
      present.set(key, present.get(key)! + 1);
      const value = typeof raw === "string" && nulls.has(raw) ? null : raw;
      const observed = inferValueType(value);
      if (observed === "null") {
        nullable.set(key, true);
      } else {
        types.set(key, unifyTypes(types.get(key)!, observed));
      }
    }
  }

  return order.map((name) => ({
    name,
    type: types.get(name)!,
    // A column absent from some rows is nullable by definition.
    nullable: nullable.get(name)! || present.get(name)! < limit,
  }));
}

/** Column statistics for the data preview panel. */
export function profileRows(rows: readonly Row[], options: InferOptions = {}): ColumnProfile[] {
  const schema = inferSchema(rows, options);
  const nulls = new Set(options.nullValues ?? []);
  const limit = Math.min(rows.length, options.sampleSize ?? 1000);

  return schema.map((column) => {
    const seen = new Set<string>();
    let nullCount = 0;
    const sample: unknown[] = [];
    let min: string | number | undefined;
    let max: string | number | undefined;

    for (let i = 0; i < limit; i++) {
      const raw = rows[i]![column.name];
      const value = typeof raw === "string" && nulls.has(raw) ? null : raw;
      if (value === null || value === undefined || value === "") { nullCount++; continue; }
      if (seen.size < 100_000) seen.add(typeof value === "object" ? JSON.stringify(value) : String(value));
      if (sample.length < 5) sample.push(value);

      if (column.type === "integer" || column.type === "float") {
        const n = Number(value);
        if (!Number.isNaN(n)) {
          min = min === undefined ? n : Math.min(Number(min), n);
          max = max === undefined ? n : Math.max(Number(max), n);
        }
      } else if (column.type === "date" || column.type === "timestamp") {
        const s = value instanceof Date ? value.toISOString() : String(value);
        min = min === undefined || s < String(min) ? s : min;
        max = max === undefined || s > String(max) ? s : max;
      }
    }

    return {
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      nullCount,
      uniqueCount: seen.size,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      sample,
    };
  });
}

/** Best-effort coercion of a string cell to the inferred column type. */
export function coerceValue(value: unknown, type: DataType): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  switch (type) {
    case "integer": {
      const n = Number.parseInt(value, 10);
      return Number.isNaN(n) ? null : n;
    }
    case "float": {
      const n = Number.parseFloat(value);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      if (/^(true|t|yes|y|1)$/i.test(value)) return true;
      if (/^(false|f|no|n|0)$/i.test(value)) return false;
      return null;
    case "json":
      try { return JSON.parse(value); } catch { return value; }
    default:
      return value;
  }
}

export function coerceRows(rows: readonly Row[], schema: readonly ColumnSchema[]): Row[] {
  const byName = new Map(schema.map((c) => [c.name, c.type]));
  return rows.map((row) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = coerceValue(value, byName.get(key) ?? "string");
    }
    return out;
  });
}
