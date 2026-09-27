import type { ColumnSchema, DataType } from "@dataflow-studio/schema-registry";
import { ConnectorError } from "./types.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * Identifier handling for table and column names.
 *
 * Table and column names arrive from user configuration and cannot be bound as
 * query parameters, so they are validated against a strict pattern *and* quoted.
 * Anything that does not match is rejected rather than escaped: there is no
 * legitimate pipeline that needs a table called `users"; DROP TABLE`.
 */
export function assertIdentifier(name: string, kind = "identifier"): string {
  if (!IDENTIFIER.test(name)) {
    throw new ConnectorError(
      `Invalid ${kind} "${name}": must start with a letter or underscore and contain only letters, digits, underscore or $ (max 63 chars)`,
      "validation",
    );
  }
  return name;
}

export interface QualifiedName {
  schema?: string;
  table: string;
}

export function parseQualifiedName(raw: string): QualifiedName {
  const parts = raw.split(".");
  if (parts.length === 1) return { table: assertIdentifier(parts[0]!, "table name") };
  if (parts.length === 2) {
    return { schema: assertIdentifier(parts[0]!, "schema name"), table: assertIdentifier(parts[1]!, "table name") };
  }
  throw new ConnectorError(`Invalid table reference "${raw}": expected "table" or "schema.table"`, "validation");
}

export function quoteIdentifier(name: string, quote: '"' | "`"): string {
  assertIdentifier(name);
  return `${quote}${name}${quote}`;
}

export function quoteQualified(name: QualifiedName, quote: '"' | "`"): string {
  return name.schema
    ? `${quoteIdentifier(name.schema, quote)}.${quoteIdentifier(name.table, quote)}`
    : quoteIdentifier(name.table, quote);
}

/** Rejects anything that is not a single SELECT before it reaches a database. */
export function assertReadOnlyQuery(sql: string): string {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new ConnectorError(
      "Source queries must be a single SELECT statement; use a destination node to write data",
      "validation",
    );
  }
  // A semicolon anywhere but the very end means more than one statement.
  const withoutTrailing = stripped.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new ConnectorError("Source queries must contain exactly one statement", "validation");
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|merge)\b/i.test(withoutTrailing)) {
    throw new ConnectorError(
      "Source queries must not contain data-modifying keywords",
      "validation",
    );
  }
  return withoutTrailing;
}

const POSTGRES_TYPES: Record<DataType, string> = {
  string: "text",
  integer: "bigint",
  float: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
  date: "date",
  json: "jsonb",
  unknown: "text",
};

const MYSQL_TYPES: Record<DataType, string> = {
  string: "text",
  integer: "bigint",
  float: "double",
  boolean: "tinyint(1)",
  timestamp: "datetime",
  date: "date",
  json: "json",
  unknown: "text",
};

export function columnDefinition(column: ColumnSchema, dialect: "postgres" | "mysql"): string {
  const types = dialect === "postgres" ? POSTGRES_TYPES : MYSQL_TYPES;
  const quote = dialect === "postgres" ? '"' : "`";
  return `${quoteIdentifier(column.name, quote)} ${types[column.type]}${column.nullable ? "" : " NOT NULL"}`;
}
