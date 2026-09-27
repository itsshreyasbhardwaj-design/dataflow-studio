import { inferSchema, makeBatch, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import { compareValues, toNumber } from "./sql/evaluate.js";
import { TransformConfigError } from "./filter.js";

export const MEASURE_FUNCTIONS = ["sum", "avg", "min", "max", "count", "count_distinct", "first", "last"] as const;
export type AggregateFunction = (typeof MEASURE_FUNCTIONS)[number];

export interface Measure {
  column?: string;
  fn: AggregateFunction;
  as: string;
}

export function parseMeasures(input: unknown): Measure[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TransformConfigError("`measures` must be a non-empty array");
  }
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TransformConfigError(`measures[${index}] must be an object`);
    }
    const m = entry as Record<string, unknown>;
    const fn = m["fn"];
    if (typeof fn !== "string" || !(MEASURE_FUNCTIONS as readonly string[]).includes(fn)) {
      throw new TransformConfigError(`measures[${index}].fn must be one of: ${MEASURE_FUNCTIONS.join(", ")}`);
    }
    if (fn !== "count" && typeof m["column"] !== "string") {
      throw new TransformConfigError(`measures[${index}] with fn "${fn}" requires a column`);
    }
    const as = m["as"] ?? (typeof m["column"] === "string" ? `${fn}_${m["column"]}` : fn);
    if (typeof as !== "string" || !as) {
      throw new TransformConfigError(`measures[${index}].as must be a non-empty string`);
    }
    return {
      ...(typeof m["column"] === "string" ? { column: m["column"] } : {}),
      fn: fn as AggregateFunction,
      as,
    };
  });
}

function computeMeasure(measure: Measure, rows: readonly Row[]): unknown {
  if (measure.fn === "count") return rows.length;
  const column = measure.column!;
  const values = rows.map((row) => row[column]).filter((v) => v !== null && v !== undefined);

  switch (measure.fn) {
    case "count_distinct":
      return new Set(values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))).size;
    case "sum": case "avg": {
      if (!values.length) return null;
      let sum = 0;
      for (const value of values) {
        const n = toNumber(value);
        if (n === null) {
          throw new TransformConfigError(
            `Measure "${measure.as}" cannot ${measure.fn} non-numeric value "${String(value)}" in column "${column}"`,
          );
        }
        sum += n;
      }
      return measure.fn === "sum" ? sum : sum / values.length;
    }
    case "min": case "max":
      if (!values.length) return null;
      return values.reduce((best, candidate) => {
        const cmp = compareValues(candidate, best) ?? 0;
        return (measure.fn === "max" ? cmp > 0 : cmp < 0) ? candidate : best;
      });
    case "first": return rows.length ? rows[0]![column] ?? null : null;
    case "last": return rows.length ? rows.at(-1)![column] ?? null : null;
  }
}

export interface AggregateOptions {
  groupBy?: string[];
  measures: Measure[];
}

export function applyAggregate(batch: DataBatch, options: AggregateOptions): DataBatch {
  const groupBy = options.groupBy ?? [];
  const known = new Set(batch.columns.map((c) => c.name));
  for (const column of [...groupBy, ...options.measures.map((m) => m.column).filter(Boolean) as string[]]) {
    if (!known.has(column) && batch.rows.length > 0) {
      throw new TransformConfigError(
        `Aggregate references unknown column "${column}". Available columns: ${[...known].join(", ")}`,
      );
    }
  }

  const groups = new Map<string, { key: Row; rows: Row[] }>();
  if (!groupBy.length) {
    groups.set("", { key: {}, rows: [...batch.rows] });
  } else {
    for (const row of batch.rows) {
      const keyValues = groupBy.map((column) => row[column] ?? null);
      const mapKey = JSON.stringify(keyValues);
      const existing = groups.get(mapKey);
      if (existing) existing.rows.push(row);
      else groups.set(mapKey, { key: Object.fromEntries(groupBy.map((c, i) => [c, keyValues[i]])), rows: [row] });
    }
  }

  const rows: Row[] = [...groups.values()].map(({ key, rows: groupRows }) => {
    const out: Row = { ...key };
    for (const measure of options.measures) out[measure.as] = computeMeasure(measure, groupRows);
    return out;
  });

  return makeBatch(rows, inferSchema(rows), { ...(batch.dataset ? { dataset: batch.dataset } : {}) });
}
