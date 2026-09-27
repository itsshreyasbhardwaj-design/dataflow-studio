import { inferSchema, makeBatch, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import { compareValues } from "./sql/evaluate.js";

export const FILTER_OPERATORS = [
  "eq", "ne", "gt", "gte", "lt", "lte",
  "in", "not_in", "null", "not_null",
  "contains", "not_contains", "starts_with", "ends_with", "matches", "between",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface Predicate {
  column: string;
  op: FilterOperator;
  value?: unknown;
  /** For `between`. */
  high?: unknown;
  caseInsensitive?: boolean;
}

export class TransformConfigError extends Error {
  readonly errorClass = "configuration";
  constructor(message: string) {
    super(message);
    this.name = "TransformConfigError";
  }
}

const MAX_REGEX_LENGTH = 512;

export function parsePredicates(input: unknown): Predicate[] {
  if (!Array.isArray(input)) throw new TransformConfigError("`predicates` must be an array");
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TransformConfigError(`predicates[${index}] must be an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p["column"] !== "string" || !p["column"]) {
      throw new TransformConfigError(`predicates[${index}].column must be a non-empty string`);
    }
    const op = p["op"];
    if (typeof op !== "string" || !(FILTER_OPERATORS as readonly string[]).includes(op)) {
      throw new TransformConfigError(
        `predicates[${index}].op must be one of: ${FILTER_OPERATORS.join(", ")}`,
      );
    }
    if ((op === "in" || op === "not_in") && !Array.isArray(p["value"])) {
      throw new TransformConfigError(`predicates[${index}] with op "${op}" requires an array value`);
    }
    if (op === "between" && (p["value"] === undefined || p["high"] === undefined)) {
      throw new TransformConfigError(`predicates[${index}] with op "between" requires \`value\` and \`high\``);
    }
    if (op === "matches") {
      const pattern = p["value"];
      if (typeof pattern !== "string") {
        throw new TransformConfigError(`predicates[${index}] with op "matches" requires a string pattern`);
      }
      if (pattern.length > MAX_REGEX_LENGTH) {
        throw new TransformConfigError(`predicates[${index}] pattern exceeds ${MAX_REGEX_LENGTH} characters`);
      }
      // Fail fast on an invalid pattern rather than per-row.
      try { new RegExp(pattern); } catch (error) {
        throw new TransformConfigError(`predicates[${index}] pattern is invalid: ${(error as Error).message}`);
      }
    }
    return {
      column: p["column"],
      op: op as FilterOperator,
      ...(p["value"] !== undefined ? { value: p["value"] } : {}),
      ...(p["high"] !== undefined ? { high: p["high"] } : {}),
      ...(p["caseInsensitive"] !== undefined ? { caseInsensitive: Boolean(p["caseInsensitive"]) } : {}),
    };
  });
}

function text(value: unknown, caseInsensitive?: boolean): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return caseInsensitive ? str.toLowerCase() : str;
}

export function evaluatePredicate(predicate: Predicate, row: Row): boolean {
  const value = row[predicate.column] ?? null;
  const expected = predicate.value;

  switch (predicate.op) {
    case "null": return value === null || value === undefined;
    case "not_null": return value !== null && value !== undefined;
    case "eq": return compareValues(value, expected) === 0;
    case "ne": {
      const cmp = compareValues(value, expected);
      // NULL <> x is UNKNOWN, which does not pass the filter.
      return cmp === null ? false : cmp !== 0;
    }
    case "gt": return (compareValues(value, expected) ?? -1) > 0;
    case "gte": return (compareValues(value, expected) ?? -1) >= 0;
    case "lt": { const cmp = compareValues(value, expected); return cmp === null ? false : cmp < 0; }
    case "lte": { const cmp = compareValues(value, expected); return cmp === null ? false : cmp <= 0; }
    case "in": return (expected as unknown[]).some((candidate) => compareValues(value, candidate) === 0);
    case "not_in":
      if (value === null || value === undefined) return false;
      return !(expected as unknown[]).some((candidate) => compareValues(value, candidate) === 0);
    case "between": {
      const low = compareValues(value, expected);
      const high = compareValues(value, predicate.high);
      return low !== null && high !== null && low >= 0 && high <= 0;
    }
    case "contains": case "not_contains": {
      const haystack = text(value, predicate.caseInsensitive);
      const needle = text(expected, predicate.caseInsensitive);
      if (haystack === null || needle === null) return false;
      const found = haystack.includes(needle);
      return predicate.op === "contains" ? found : !found;
    }
    case "starts_with": {
      const haystack = text(value, predicate.caseInsensitive);
      const needle = text(expected, predicate.caseInsensitive);
      return haystack !== null && needle !== null && haystack.startsWith(needle);
    }
    case "ends_with": {
      const haystack = text(value, predicate.caseInsensitive);
      const needle = text(expected, predicate.caseInsensitive);
      return haystack !== null && needle !== null && haystack.endsWith(needle);
    }
    case "matches": {
      const haystack = text(value);
      if (haystack === null) return false;
      return new RegExp(String(expected), predicate.caseInsensitive ? "i" : "").test(haystack);
    }
  }
}

export interface FilterOptions {
  predicates: Predicate[];
  combine?: "and" | "or";
}

export function applyFilter(batch: DataBatch, options: FilterOptions): DataBatch {
  const { predicates, combine = "and" } = options;
  if (!predicates.length) return batch;

  const missing = predicates
    .map((p) => p.column)
    .filter((column) => !batch.columns.some((c) => c.name === column));
  if (missing.length && batch.rows.length > 0) {
    throw new TransformConfigError(
      `Filter references column(s) not present in the input: ${[...new Set(missing)].join(", ")}. ` +
      `Available columns: ${batch.columns.map((c) => c.name).join(", ")}`,
    );
  }

  const rows = batch.rows.filter((row) =>
    combine === "and"
      ? predicates.every((p) => evaluatePredicate(p, row))
      : predicates.some((p) => evaluatePredicate(p, row)),
  );
  return makeBatch(rows, rows.length ? inferSchema(rows) : batch.columns, {
    ...(batch.dataset ? { dataset: batch.dataset } : {}),
  });
}
