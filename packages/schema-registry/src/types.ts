export const DATA_TYPES = [
  "string",
  "integer",
  "float",
  "boolean",
  "timestamp",
  "date",
  "json",
  "unknown",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export interface ColumnSchema {
  name: string;
  type: DataType;
  nullable: boolean;
  description?: string;
}

export interface DataSchema {
  /** Catalog name of the dataset this schema describes. */
  dataset: string;
  version: number;
  columns: ColumnSchema[];
  /** Content hash of the column list, used to detect "no real change". */
  fingerprint: string;
  createdAt: string;
  /** Run that produced this schema version, when it was observed rather than declared. */
  observedInRunId?: string;
}

export type Row = Record<string, unknown>;

export interface ColumnProfile {
  name: string;
  type: DataType;
  nullable: boolean;
  nullCount: number;
  uniqueCount: number;
  /** Populated for numeric and temporal columns. */
  min?: string | number;
  max?: string | number;
  sample: unknown[];
}

export const SCHEMA_CHANGE_CLASSES = ["COMPATIBLE", "WARNING", "BREAKING"] as const;
export type SchemaChangeClass = (typeof SCHEMA_CHANGE_CLASSES)[number];

export type SchemaChangeKind =
  | "column_added"
  | "column_removed"
  | "type_changed"
  | "nullability_relaxed"
  | "nullability_tightened";

export interface SchemaChange {
  kind: SchemaChangeKind;
  column: string;
  classification: SchemaChangeClass;
  from?: { type: DataType; nullable: boolean };
  to?: { type: DataType; nullable: boolean };
  reason: string;
}

export interface SchemaDiff {
  changes: SchemaChange[];
  /** The most severe classification across all changes. */
  classification: SchemaChangeClass;
  compatible: boolean;
}

/** A batch of rows moving between nodes, with the schema observed for it. */
export interface DataBatch {
  rows: Row[];
  columns: ColumnSchema[];
  rowCount: number;
  /** True when the producer capped the read; consumers surface this to the user. */
  truncated?: boolean;
  /** Dataset this batch represents, when the producing node declared one. */
  dataset?: string;
}

export function makeBatch(rows: Row[], columns: ColumnSchema[], extra: Partial<DataBatch> = {}): DataBatch {
  return { rows, columns, rowCount: rows.length, ...extra };
}
