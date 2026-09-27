import type {
  ColumnSchema, DataType, SchemaChange, SchemaChangeClass, SchemaDiff,
} from "./types.js";

/**
 * Deterministic compatibility rules for a type change. The question we answer is
 * always "will an existing consumer of the old schema still work?", never "is
 * this change tidy?".
 *
 *  - widening a numeric or temporal type is COMPATIBLE;
 *  - losing precision or changing representation is BREAKING;
 *  - stringifying a value keeps the data readable but breaks arithmetic, so it
 *    is a WARNING that a human must look at.
 */
const TYPE_TRANSITIONS: Record<string, SchemaChangeClass> = {
  "integer->float": "COMPATIBLE",
  "date->timestamp": "COMPATIBLE",
  "unknown->string": "COMPATIBLE",
  "unknown->integer": "COMPATIBLE",
  "unknown->float": "COMPATIBLE",
  "unknown->boolean": "COMPATIBLE",
  "unknown->date": "COMPATIBLE",
  "unknown->timestamp": "COMPATIBLE",
  "unknown->json": "COMPATIBLE",

  "integer->string": "WARNING",
  "float->string": "WARNING",
  "boolean->string": "WARNING",
  "date->string": "WARNING",
  "timestamp->string": "WARNING",
  "json->string": "WARNING",
  "integer->json": "WARNING",
  "float->json": "WARNING",
  "string->json": "WARNING",
  "boolean->json": "WARNING",
};

export function classifyTypeChange(from: DataType, to: DataType): SchemaChangeClass {
  if (from === to) return "COMPATIBLE";
  return TYPE_TRANSITIONS[`${from}->${to}`] ?? "BREAKING";
}

const SEVERITY: Record<SchemaChangeClass, number> = { COMPATIBLE: 0, WARNING: 1, BREAKING: 2 };

export function worstClassification(classes: readonly SchemaChangeClass[]): SchemaChangeClass {
  return classes.reduce<SchemaChangeClass>(
    (worst, cls) => (SEVERITY[cls] > SEVERITY[worst] ? cls : worst),
    "COMPATIBLE",
  );
}

export function diffSchemas(
  before: readonly ColumnSchema[],
  after: readonly ColumnSchema[],
): SchemaDiff {
  const beforeByName = new Map(before.map((c) => [c.name, c]));
  const afterByName = new Map(after.map((c) => [c.name, c]));
  const changes: SchemaChange[] = [];

  for (const column of after) {
    if (beforeByName.has(column.name)) continue;
    // A new nullable column is additive. A new NOT NULL column breaks any writer
    // that does not know about it yet, so it needs a human decision.
    const classification: SchemaChangeClass = column.nullable ? "COMPATIBLE" : "WARNING";
    changes.push({
      kind: "column_added",
      column: column.name,
      classification,
      to: { type: column.type, nullable: column.nullable },
      reason: column.nullable
        ? "New nullable column; existing consumers are unaffected"
        : "New non-nullable column; writers that do not populate it will fail",
    });
  }

  for (const column of before) {
    if (afterByName.has(column.name)) continue;
    changes.push({
      kind: "column_removed",
      column: column.name,
      classification: "BREAKING",
      from: { type: column.type, nullable: column.nullable },
      reason: "Column removed; any consumer selecting it will fail",
    });
  }

  for (const column of after) {
    const previous = beforeByName.get(column.name);
    if (!previous) continue;

    if (previous.type !== column.type) {
      const classification = classifyTypeChange(previous.type, column.type);
      changes.push({
        kind: "type_changed",
        column: column.name,
        classification,
        from: { type: previous.type, nullable: previous.nullable },
        to: { type: column.type, nullable: column.nullable },
        reason:
          classification === "COMPATIBLE"
            ? `Widened ${previous.type} to ${column.type}`
            : classification === "WARNING"
              ? `Changed ${previous.type} to ${column.type}; representation changed but values are preserved`
              : `Changed ${previous.type} to ${column.type}; existing values may not survive the conversion`,
      });
    }

    if (previous.nullable !== column.nullable) {
      changes.push(
        column.nullable
          ? {
              kind: "nullability_relaxed",
              column: column.name,
              classification: "WARNING",
              from: { type: previous.type, nullable: false },
              to: { type: column.type, nullable: true },
              reason: "Column now allows NULL; consumers that assume a value may break",
            }
          : {
              kind: "nullability_tightened",
              column: column.name,
              classification: "COMPATIBLE",
              from: { type: previous.type, nullable: true },
              to: { type: column.type, nullable: false },
              reason: "Column no longer allows NULL; stricter than before",
            },
      );
    }
  }

  const classification = worstClassification(changes.map((c) => c.classification));
  return { changes, classification, compatible: classification !== "BREAKING" };
}

export function formatSchemaDiff(diff: SchemaDiff): string {
  if (!diff.changes.length) return "No schema changes";
  return diff.changes
    .map((c) => {
      const prefix = c.kind === "column_added" ? "+" : c.kind === "column_removed" ? "-" : "~";
      const detail =
        c.kind === "type_changed"
          ? `${c.from?.type} -> ${c.to?.type}`
          : c.kind === "column_added"
            ? `${c.to?.type}${c.to?.nullable ? " NULL" : " NOT NULL"}`
            : c.kind === "column_removed"
              ? `${c.from?.type}`
              : c.kind === "nullability_relaxed"
                ? "NOT NULL -> NULL"
                : "NULL -> NOT NULL";
      return `${prefix} ${c.column}: ${detail} [${c.classification}]`;
    })
    .join("\n");
}
