import type { ColumnLineage } from "./types.js";

/**
 * Column-level lineage for a SQL transform.
 *
 * The caller passes the parsed select list (from @dataflow-studio/transformations)
 * rather than raw SQL, so this module stays free of a parser dependency. A
 * `SELECT *` cannot be mapped without knowing the input schema, and is reported
 * as unresolved rather than being invented.
 */
export interface SelectColumnDescriptor {
  /** Output column name. */
  name: string;
  /** Input columns referenced by the expression. */
  sources: string[];
  expression: string;
  isStar: boolean;
}

export function columnLineage(columns: readonly SelectColumnDescriptor[]): ColumnLineage[] {
  return columns.map((column) =>
    column.isStar
      ? { column: "*", sources: [], expression: "*", resolved: false }
      : { column: column.name, sources: [...new Set(column.sources)], expression: column.expression, resolved: true },
  );
}

/** Columns of the input that no output column depends on. */
export function unusedColumns(lineage: readonly ColumnLineage[], inputColumns: readonly string[]): string[] {
  if (lineage.some((l) => !l.resolved)) return [];
  const used = new Set(lineage.flatMap((l) => l.sources));
  return inputColumns.filter((column) => !used.has(column));
}
