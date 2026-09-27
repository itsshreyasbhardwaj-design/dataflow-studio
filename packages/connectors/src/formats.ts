import { coerceRows, inferSchema, makeBatch, type DataBatch, type Row } from "@dataflow-studio/schema-registry";
import { ConnectorError } from "./types.js";

export interface CsvParseOptions {
  delimiter?: string;
  hasHeader?: boolean;
  /** Stop after this many data rows. The batch is flagged `truncated`. */
  limit?: number;
  nullValues?: readonly string[];
  inferTypes?: boolean;
  maxFieldBytes?: number;
}

/**
 * RFC 4180 CSV reader. Handles quoted fields, embedded delimiters, embedded
 * newlines and doubled quotes. It parses from a string rather than a stream
 * because the file store hands us bounded buffers; the row limit is what keeps
 * a 4 GB upload from becoming a 4 GB array.
 */
export function parseCsv(input: string, options: CsvParseOptions = {}): DataBatch {
  const delimiter = options.delimiter ?? ",";
  if (delimiter.length !== 1) {
    throw new ConnectorError(`CSV delimiter must be a single character, got "${delimiter}"`, "configuration");
  }
  const hasHeader = options.hasHeader ?? true;
  const limit = options.limit ?? 1_000_000;
  const maxFieldBytes = options.maxFieldBytes ?? 1024 * 1024;

  // Strip a UTF-8 BOM, which Excel adds and which otherwise corrupts the first header.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;
  let truncated = false;

  const endField = (): void => {
    if (field.length > maxFieldBytes) {
      throw new ConnectorError(`CSV field exceeds ${maxFieldBytes} bytes`, "validation");
    }
    record.push(field);
    field = "";
  };
  const endRecord = (): boolean => {
    endField();
    // Ignore a trailing blank line.
    if (record.length === 1 && record[0] === "" && !sawAnyChar) {
      record = [];
      return true;
    }
    records.push(record);
    record = [];
    sawAnyChar = false;
    const dataRows = hasHeader ? records.length - 1 : records.length;
    if (dataRows >= limit) { truncated = true; return false; }
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; sawAnyChar = true; continue; }
        inQuotes = false;
        continue;
      }
      field += char;
      sawAnyChar = true;
      continue;
    }
    if (char === '"' && field === "") { inQuotes = true; sawAnyChar = true; continue; }
    if (char === delimiter) { endField(); sawAnyChar = true; continue; }
    if (char === "\r") {
      if (text[i + 1] === "\n") i++;
      if (!endRecord()) break;
      continue;
    }
    if (char === "\n") {
      if (!endRecord()) break;
      continue;
    }
    field += char;
    sawAnyChar = true;
  }
  if (inQuotes) throw new ConnectorError("CSV ended inside a quoted field", "validation");
  if (field !== "" || record.length) endRecord();

  if (!records.length) return makeBatch([], []);

  const headerRow = hasHeader ? records[0]! : records[0]!.map((_, i) => `column_${i + 1}`);
  const header = dedupeHeader(headerRow);
  const dataRecords = hasHeader ? records.slice(1) : records;

  const rows: Row[] = dataRecords.map((values, index) => {
    if (values.length > header.length) {
      throw new ConnectorError(
        `CSV row ${index + (hasHeader ? 2 : 1)} has ${values.length} fields but the header declares ${header.length}`,
        "validation",
      );
    }
    const row: Row = {};
    header.forEach((name, i) => {
      const raw = values[i];
      row[name] = raw === undefined ? null : raw;
    });
    return row;
  });

  const nullValues = options.nullValues ?? ["", "NULL", "null", "\\N"];
  const nulled = rows.map((row) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === "string" && nullValues.includes(value) ? null : value;
    }
    return out;
  });

  const columns = inferSchema(nulled, { nullValues });
  const finalRows = options.inferTypes === false ? nulled : coerceRows(nulled, columns);
  return makeBatch(finalRows, columns, truncated ? { truncated: true } : {});
}

function dedupeHeader(header: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, index) => {
    const base = raw.trim() || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function writeCsv(batch: DataBatch, options: { delimiter?: string; header?: boolean } = {}): string {
  const delimiter = options.delimiter ?? ",";
  const columns = batch.columns.length ? batch.columns.map((c) => c.name) : Object.keys(batch.rows[0] ?? {});
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines: string[] = [];
  if (options.header !== false) lines.push(columns.map(escape).join(delimiter));
  for (const row of batch.rows) lines.push(columns.map((column) => escape(row[column])).join(delimiter));
  return lines.join("\n") + (lines.length ? "\n" : "");
}

export interface JsonParseOptions {
  format?: "array" | "ndjson";
  /** Dot path to the array of records, e.g. `data.items`. */
  recordPath?: string;
  limit?: number;
}

export function parseJsonRecords(input: string, options: JsonParseOptions = {}): DataBatch {
  const limit = options.limit ?? 1_000_000;
  let records: unknown[];

  if (options.format === "ndjson") {
    const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);
    records = lines.slice(0, limit).map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new ConnectorError(`NDJSON line ${index + 1} is not valid JSON: ${(error as Error).message}`, "validation");
      }
    });
    const truncated = lines.length > limit;
    return toBatch(records, truncated);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch (error) {
    throw new ConnectorError(`Input is not valid JSON: ${(error as Error).message}`, "validation");
  }
  const located = options.recordPath ? extractPath(parsed, options.recordPath) : parsed;
  if (!Array.isArray(located)) {
    throw new ConnectorError(
      options.recordPath
        ? `Path "${options.recordPath}" did not resolve to an array`
        : "Expected a JSON array of records; set a record path if the array is nested",
      "validation",
    );
  }
  const truncated = located.length > limit;
  return toBatch(located.slice(0, limit), truncated);
}

function toBatch(records: unknown[], truncated: boolean): DataBatch {
  const rows: Row[] = records.map((record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      // Wrap scalars so a list of primitives is still usable.
      return { value: record } as Row;
    }
    return flattenRecord(record as Record<string, unknown>, index);
  });
  const columns = inferSchema(rows);
  return makeBatch(rows, columns, truncated ? { truncated: true } : {});
}

/** Flattens one level of nesting; deeper structures stay as JSON values. */
function flattenRecord(record: Record<string, unknown>, _index: number): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        row[`${key}_${nestedKey}`] = nestedValue as Row[string];
      }
    } else {
      row[key] = value as Row[string];
    }
  }
  return row;
}

export function extractPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function writeJson(batch: DataBatch, options: { format?: "array" | "ndjson" } = {}): string {
  if (options.format === "ndjson") return batch.rows.map((row) => JSON.stringify(row)).join("\n") + (batch.rows.length ? "\n" : "");
  return JSON.stringify(batch.rows, null, 2) + "\n";
}
