import { inferSchema, makeBatch, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import { compareValues } from "./sql/evaluate.js";
import { TransformConfigError } from "./filter.js";

export type JoinKind = "inner" | "left" | "right" | "full";

export interface JoinKey {
  left: string;
  right: string;
}

export interface JoinOptions {
  on: JoinKey[];
  type?: JoinKind;
  /** Prefix applied to right-side columns that collide with the left side. */
  rightPrefix?: string;
  maxOutputRows?: number;
}

export function parseJoinKeys(input: unknown): JoinKey[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TransformConfigError("`on` must be a non-empty array of key pairs");
  }
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TransformConfigError(`on[${index}] must be an object`);
    }
    const pair = entry as Record<string, unknown>;
    if (typeof pair["left"] !== "string" || typeof pair["right"] !== "string") {
      throw new TransformConfigError(`on[${index}] requires string \`left\` and \`right\` column names`);
    }
    return { left: pair["left"], right: pair["right"] };
  });
}

const DEFAULT_MAX_OUTPUT_ROWS = 5_000_000;

/**
 * Hash join over two batches. Keys containing NULL never match, matching SQL
 * semantics - a NULL customer_id on both sides is not "the same customer".
 */
export function applyJoin(left: DataBatch, right: DataBatch, options: JoinOptions): DataBatch {
  const type = options.type ?? "inner";
  const maxOutputRows = options.maxOutputRows ?? DEFAULT_MAX_OUTPUT_ROWS;
  const prefix = options.rightPrefix ?? "";

  const leftColumns = new Set(left.columns.map((c) => c.name));
  for (const key of options.on) {
    if (left.rows.length && !leftColumns.has(key.left)) {
      throw new TransformConfigError(`Join key "${key.left}" is not present on the left input`);
    }
    if (right.rows.length && !right.columns.some((c) => c.name === key.right)) {
      throw new TransformConfigError(`Join key "${key.right}" is not present on the right input`);
    }
  }

  const rightColumnNames = right.columns.map((c) => c.name);
  const renamed = new Map<string, string>(
    rightColumnNames.map((name) => [name, leftColumns.has(name) ? `${prefix || "right_"}${name}` : name]),
  );

  const keyOf = (row: Row, columns: string[]): string | null => {
    const values = columns.map((column) => row[column] ?? null);
    if (values.some((v) => v === null)) return null;
    return JSON.stringify(values.map((v) => (v instanceof Date ? v.toISOString() : v)));
  };

  const buckets = new Map<string, Row[]>();
  for (const row of right.rows) {
    const key = keyOf(row, options.on.map((k) => k.right));
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const nullRight: Row = Object.fromEntries(rightColumnNames.map((name) => [renamed.get(name)!, null]));
  const nullLeft: Row = Object.fromEntries(left.columns.map((c) => [c.name, null]));

  const merge = (leftRow: Row | null, rightRow: Row | null): Row => {
    const out: Row = leftRow ? { ...leftRow } : { ...nullLeft };
    if (rightRow) {
      for (const name of rightColumnNames) out[renamed.get(name)!] = rightRow[name] ?? null;
    } else {
      Object.assign(out, nullRight);
    }
    return out;
  };

  const rows: Row[] = [];
  const matchedKeys = new Set<string>();
  const guard = (): void => {
    if (rows.length > maxOutputRows) {
      throw new TransformConfigError(
        `Join produced more than ${maxOutputRows} rows; the join keys are probably not unique enough`,
      );
    }
  };

  for (const leftRow of left.rows) {
    const key = keyOf(leftRow, options.on.map((k) => k.left));
    const matches = key === null ? undefined : buckets.get(key);
    if (matches?.length) {
      matchedKeys.add(key!);
      for (const rightRow of matches) { rows.push(merge(leftRow, rightRow)); guard(); }
    } else if (type === "left" || type === "full") {
      rows.push(merge(leftRow, null));
      guard();
    }
  }

  if (type === "right" || type === "full") {
    for (const [key, bucket] of buckets) {
      if (matchedKeys.has(key)) continue;
      for (const rightRow of bucket) { rows.push(merge(null, rightRow)); guard(); }
    }
    // Right rows whose key contained NULL never matched and are emitted as-is.
    for (const rightRow of right.rows) {
      if (keyOf(rightRow, options.on.map((k) => k.right)) === null) { rows.push(merge(null, rightRow)); guard(); }
    }
  }

  return makeBatch(rows, inferSchema(rows));
}

/** Used by the editor to preview how many rows a join would emit. */
export function estimateJoinCardinality(left: DataBatch, right: DataBatch, on: JoinKey[]): number {
  const counts = new Map<string, number>();
  for (const row of right.rows) {
    const key = JSON.stringify(on.map((k) => row[k.right] ?? null));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const row of left.rows) {
    total += counts.get(JSON.stringify(on.map((k) => row[k.left] ?? null))) ?? 0;
  }
  return total;
}

