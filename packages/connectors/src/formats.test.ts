import { describe, expect, it } from "vitest";
import { extractPath, parseCsv, parseJsonRecords, writeCsv, writeJson } from "./formats.js";
import { generateRows } from "./generator.js";
import { ConnectorError } from "./types.js";

describe("parseCsv", () => {
  it("parses a header and typed rows", () => {
    const batch = parseCsv("id,name,amount\n1,Ada,10.5\n2,Grace,20\n");
    expect(batch.rows).toEqual([
      { id: 1, name: "Ada", amount: 10.5 },
      { id: 2, name: "Grace", amount: 20 },
    ]);
    expect(batch.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["id:integer", "name:string", "amount:float"]);
  });

  it("handles quoted fields with delimiters, quotes and newlines", () => {
    const batch = parseCsv('a,b\n"x,y","he said ""hi"""\n"multi\nline",z\n');
    expect(batch.rows).toEqual([
      { a: "x,y", b: 'he said "hi"' },
      { a: "multi\nline", b: "z" },
    ]);
  });

  it("supports CRLF line endings and a UTF-8 BOM", () => {
    const batch = parseCsv("﻿id,name\r\n1,Ada\r\n");
    expect(batch.rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(batch.columns[0]!.name).toBe("id");
  });

  it("supports a custom delimiter", () => {
    expect(parseCsv("a;b\n1;2\n", { delimiter: ";" }).rows).toEqual([{ a: 1, b: 2 }]);
  });

  it("generates column names when there is no header", () => {
    expect(parseCsv("1,2\n3,4\n", { hasHeader: false }).rows).toEqual([
      { column_1: 1, column_2: 2 },
      { column_1: 3, column_2: 4 },
    ]);
  });

  it("dedupes repeated header names", () => {
    expect(parseCsv("id,id\n1,2\n").columns.map((c) => c.name)).toEqual(["id", "id_2"]);
  });

  it("maps configured null sentinels to null", () => {
    const batch = parseCsv("a,b\n\\N,2\n", { nullValues: ["\\N"] });
    expect(batch.rows).toEqual([{ a: null, b: 2 }]);
    expect(batch.columns[0]!.nullable).toBe(true);
  });

  it("can skip type inference", () => {
    expect(parseCsv("a\n1\n", { inferTypes: false }).rows).toEqual([{ a: "1" }]);
  });

  it("stops at the row limit and flags truncation", () => {
    const csv = "a\n" + Array.from({ length: 50 }, (_, i) => i).join("\n") + "\n";
    const batch = parseCsv(csv, { limit: 10 });
    expect(batch.rowCount).toBe(10);
    expect(batch.truncated).toBe(true);
  });

  it("fills missing trailing fields with null", () => {
    expect(parseCsv("a,b,c\n1,2\n").rows).toEqual([{ a: 1, b: 2, c: null }]);
  });

  it("rejects a row with more fields than the header", () => {
    expect(() => parseCsv("a,b\n1,2,3\n")).toThrow(/has 3 fields but the header declares 2/);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('a\n"unclosed\n')).toThrow(/ended inside a quoted field/);
  });

  it("rejects a multi-character delimiter", () => {
    expect(() => parseCsv("a\n1\n", { delimiter: "||" })).toThrow(ConnectorError);
  });

  it("returns an empty batch for empty input", () => {
    expect(parseCsv("").rowCount).toBe(0);
  });

  it("ignores a trailing newline rather than emitting a blank row", () => {
    expect(parseCsv("a\n1\n\n").rowCount).toBe(1);
  });
});

describe("writeCsv", () => {
  it("round-trips through parseCsv", () => {
    const original = parseCsv('id,label\n1,"a,b"\n2,"say ""hi"""\n');
    const text = writeCsv(original);
    expect(parseCsv(text).rows).toEqual(original.rows);
  });

  it("writes NULL as an empty field", () => {
    expect(writeCsv({ rows: [{ a: null }], columns: [{ name: "a", type: "string", nullable: true }], rowCount: 1 }))
      .toBe("a\n\n");
  });

  it("can omit the header", () => {
    expect(writeCsv({ rows: [{ a: 1 }], columns: [{ name: "a", type: "integer", nullable: false }], rowCount: 1 }, { header: false }))
      .toBe("1\n");
  });
});

describe("parseJsonRecords", () => {
  it("parses an array of objects", () => {
    expect(parseJsonRecords('[{"a":1},{"a":2}]').rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses NDJSON", () => {
    expect(parseJsonRecords('{"a":1}\n{"a":2}\n', { format: "ndjson" }).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("follows a record path", () => {
    expect(parseJsonRecords('{"data":{"items":[{"a":1}]}}', { recordPath: "data.items" }).rows).toEqual([{ a: 1 }]);
  });

  it("flattens one level of nesting", () => {
    expect(parseJsonRecords('[{"id":1,"user":{"name":"Ada","age":36}}]').rows).toEqual([
      { id: 1, user_name: "Ada", user_age: 36 },
    ]);
  });

  it("keeps arrays as JSON values", () => {
    expect(parseJsonRecords('[{"tags":["a","b"]}]').rows[0]!["tags"]).toEqual(["a", "b"]);
  });

  it("wraps scalars so a list of primitives is usable", () => {
    expect(parseJsonRecords("[1,2]").rows).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("enforces the limit", () => {
    const batch = parseJsonRecords(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ i }))), { limit: 5 });
    expect(batch.rowCount).toBe(5);
    expect(batch.truncated).toBe(true);
  });

  it("reports invalid JSON clearly", () => {
    expect(() => parseJsonRecords("{nope")).toThrow(/not valid JSON/);
    expect(() => parseJsonRecords("{bad}\n", { format: "ndjson" })).toThrow(/NDJSON line 1/);
  });

  it("reports a record path that does not resolve to an array", () => {
    expect(() => parseJsonRecords('{"data":5}', { recordPath: "data" })).toThrow(/did not resolve to an array/);
    expect(() => parseJsonRecords('{"data":[]}')).toThrow(/set a record path/);
  });
});

describe("writeJson", () => {
  it("writes an array or NDJSON", () => {
    const batch = { rows: [{ a: 1 }, { a: 2 }], columns: [{ name: "a", type: "integer" as const, nullable: false }], rowCount: 2 };
    expect(JSON.parse(writeJson(batch))).toEqual(batch.rows);
    expect(writeJson(batch, { format: "ndjson" })).toBe('{"a":1}\n{"a":2}\n');
  });
});

describe("extractPath", () => {
  it("walks dotted paths and returns undefined for misses", () => {
    expect(extractPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
    expect(extractPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(extractPath({ a: 1 }, "")).toEqual({ a: 1 });
  });
});

describe("generateRows", () => {
  it("is deterministic for a given seed", () => {
    const a = generateRows({ preset: "sales", rowCount: 20, seed: 7 });
    const b = generateRows({ preset: "sales", rowCount: 20, seed: 7 });
    expect(a.rows).toEqual(b.rows);
  });

  it("differs for a different seed", () => {
    expect(generateRows({ rowCount: 20, seed: 1 }).rows).not.toEqual(generateRows({ rowCount: 20, seed: 2 }).rows);
  });

  it("produces the expected shape per preset", () => {
    expect(generateRows({ preset: "sales", rowCount: 1 }).columns.map((c) => c.name))
      .toEqual(["order_id", "customer_id", "region", "status", "amount", "created_at"]);
    expect(generateRows({ preset: "customers", rowCount: 1 }).columns.map((c) => c.name))
      .toEqual(["id", "name", "email", "tier", "lifetime_value", "signed_up_at"]);
    expect(generateRows({ preset: "events", rowCount: 1 }).columns.map((c) => c.name))
      .toEqual(["event_id", "user_id", "event_name", "properties_source", "value", "occurred_at"]);
  });

  it("injects nulls at approximately the requested rate", () => {
    const batch = generateRows({ preset: "sales", rowCount: 2000, seed: 3, nullRate: 0.1 });
    const nulls = batch.rows.filter((r) => r["customer_id"] === null).length;
    expect(nulls).toBeGreaterThan(120);
    expect(nulls).toBeLessThan(280);
  });

  it("emits no nulls by default", () => {
    expect(generateRows({ rowCount: 200 }).rows.some((r) => r["customer_id"] === null)).toBe(false);
  });

  it("rejects an absurd row count", () => {
    expect(() => generateRows({ rowCount: 10_000_000 })).toThrow(ConnectorError);
  });
});
