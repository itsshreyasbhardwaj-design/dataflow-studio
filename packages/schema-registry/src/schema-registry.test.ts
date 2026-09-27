import { describe, expect, it } from "vitest";
import { coerceRows, inferSchema, inferValueType, profileRows, unifyTypes } from "./infer.js";
import { classifyTypeChange, diffSchemas, formatSchemaDiff, worstClassification } from "./evolution.js";
import { fingerprintColumns, SchemaRegistry, type SchemaStore } from "./registry.js";
import type { ColumnSchema, DataSchema } from "./types.js";

describe("inferValueType", () => {
  it.each([
    [null, "null"], ["", "null"], [undefined, "null"],
    [true, "boolean"], ["true", "boolean"], ["FALSE", "boolean"],
    [42, "integer"], ["42", "integer"], [-7, "integer"],
    [4.2, "float"], ["4.2", "float"], ["1e5", "float"],
    ["2026-03-31", "date"],
    ["2026-03-31T02:00:00Z", "timestamp"], ["2026-03-31 02:00:00", "timestamp"],
    [new Date(), "timestamp"],
    ["hello", "string"], ["00123456789012345678", "string"],
    [{ a: 1 }, "json"], [[1, 2], "json"],
  ])("types %s", (value, expected) => {
    expect(inferValueType(value)).toBe(expected);
  });

  it("does not guess booleans from 0/1 or y/n", () => {
    expect(inferValueType("1")).toBe("integer");
    expect(inferValueType("y")).toBe("string");
  });
});

describe("unifyTypes", () => {
  it("widens integer and float to float", () => {
    expect(unifyTypes("integer", "float")).toBe("float");
  });
  it("widens date and timestamp to timestamp", () => {
    expect(unifyTypes("date", "timestamp")).toBe("timestamp");
  });
  it("falls back to string for incompatible pairs", () => {
    expect(unifyTypes("integer", "boolean")).toBe("string");
  });
  it("absorbs unknown", () => {
    expect(unifyTypes("unknown", "integer")).toBe("integer");
  });
  it("prefers json when either side is json", () => {
    expect(unifyTypes("json", "integer")).toBe("json");
  });
});

describe("inferSchema", () => {
  it("infers types, nullability and column order", () => {
    const schema = inferSchema([
      { id: 1, name: "ada", score: 9.5, active: true, joined: "2026-01-02" },
      { id: 2, name: "grace", score: 8, active: false, joined: "2026-02-03" },
      { id: 3, name: null, score: 7.25, active: true, joined: "2026-03-04" },
    ]);
    expect(schema).toEqual([
      { name: "id", type: "integer", nullable: false },
      { name: "name", type: "string", nullable: true },
      { name: "score", type: "float", nullable: false },
      { name: "active", type: "boolean", nullable: false },
      { name: "joined", type: "date", nullable: false },
    ]);
  });

  it("treats a column missing from some rows as nullable", () => {
    const schema = inferSchema([{ a: 1, b: 2 }, { a: 2 }]);
    expect(schema.find((c) => c.name === "b")?.nullable).toBe(true);
  });

  it("honours custom null sentinels", () => {
    const schema = inferSchema([{ a: "\\N" }, { a: "5" }], { nullValues: ["\\N"] });
    expect(schema[0]).toEqual({ name: "a", type: "integer", nullable: true });
  });

  it("respects the sample size", () => {
    const rows = [{ a: 1 }, ...Array.from({ length: 100 }, () => ({ a: "text" }))];
    expect(inferSchema(rows, { sampleSize: 1 })[0]!.type).toBe("integer");
  });

  it("returns an empty schema for no rows", () => {
    expect(inferSchema([])).toEqual([]);
  });
});

describe("profileRows", () => {
  it("counts nulls and uniques and bounds numerics", () => {
    const [profile] = profileRows([{ amount: 10 }, { amount: 30 }, { amount: null }, { amount: 10 }]);
    expect(profile).toMatchObject({ name: "amount", type: "integer", nullCount: 1, uniqueCount: 2, min: 10, max: 30 });
    expect(profile!.sample).toEqual([10, 30, 10]);
  });

  it("bounds temporal columns lexically", () => {
    const [profile] = profileRows([{ at: "2026-02-01" }, { at: "2026-01-01" }]);
    expect(profile).toMatchObject({ min: "2026-01-01", max: "2026-02-01" });
  });
});

describe("coerceRows", () => {
  it("coerces strings to the inferred types", () => {
    const schema: ColumnSchema[] = [
      { name: "id", type: "integer", nullable: false },
      { name: "rate", type: "float", nullable: false },
      { name: "ok", type: "boolean", nullable: false },
      { name: "meta", type: "json", nullable: true },
      { name: "name", type: "string", nullable: false },
    ];
    expect(coerceRows([{ id: "5", rate: "1.5", ok: "yes", meta: '{"a":1}', name: "x" }], schema)).toEqual([
      { id: 5, rate: 1.5, ok: true, meta: { a: 1 }, name: "x" },
    ]);
  });

  it("maps uncoercible values to null rather than NaN", () => {
    expect(coerceRows([{ id: "abc" }], [{ name: "id", type: "integer", nullable: true }])).toEqual([{ id: null }]);
  });
});

describe("classifyTypeChange", () => {
  it.each([
    ["integer", "float", "COMPATIBLE"],
    ["date", "timestamp", "COMPATIBLE"],
    ["unknown", "string", "COMPATIBLE"],
    ["integer", "string", "WARNING"],
    ["timestamp", "string", "WARNING"],
    ["float", "integer", "BREAKING"],
    ["string", "integer", "BREAKING"],
    ["timestamp", "date", "BREAKING"],
    ["json", "integer", "BREAKING"],
  ])("%s -> %s is %s", (from, to, expected) => {
    expect(classifyTypeChange(from as never, to as never)).toBe(expected);
  });

  it("is COMPATIBLE for an unchanged type", () => {
    expect(classifyTypeChange("string", "string")).toBe("COMPATIBLE");
  });
});

describe("diffSchemas", () => {
  const v1: ColumnSchema[] = [
    { name: "id", type: "integer", nullable: false },
    { name: "name", type: "string", nullable: false },
    { name: "email", type: "string", nullable: false },
  ];

  it("reports the documented v1 -> v2 additive change", () => {
    const v2: ColumnSchema[] = [...v1, { name: "country", type: "string", nullable: true }];
    const diff = diffSchemas(v1, v2);
    expect(diff.classification).toBe("COMPATIBLE");
    expect(diff.compatible).toBe(true);
    expect(diff.changes).toEqual([
      {
        kind: "column_added",
        column: "country",
        classification: "COMPATIBLE",
        to: { type: "string", nullable: true },
        reason: "New nullable column; existing consumers are unaffected",
      },
    ]);
  });

  it("warns on a new non-nullable column", () => {
    const diff = diffSchemas(v1, [...v1, { name: "tier", type: "string", nullable: false }]);
    expect(diff.classification).toBe("WARNING");
  });

  it("marks a removed column as breaking", () => {
    const diff = diffSchemas(v1, v1.slice(0, 2));
    expect(diff.classification).toBe("BREAKING");
    expect(diff.compatible).toBe(false);
    expect(diff.changes[0]).toMatchObject({ kind: "column_removed", column: "email" });
  });

  it("marks relaxed nullability as a warning and tightened as compatible", () => {
    const relaxed = diffSchemas(v1, v1.map((c) => (c.name === "email" ? { ...c, nullable: true } : c)));
    expect(relaxed.changes[0]).toMatchObject({ kind: "nullability_relaxed", classification: "WARNING" });

    const tightened = diffSchemas(v1.map((c) => (c.name === "email" ? { ...c, nullable: true } : c)), v1);
    expect(tightened.classification).toBe("COMPATIBLE");
    expect(tightened.changes[0]).toMatchObject({ kind: "nullability_tightened" });
  });

  it("returns no changes for identical schemas", () => {
    expect(diffSchemas(v1, [...v1]).changes).toEqual([]);
  });

  it("takes the worst classification across many changes", () => {
    const diff = diffSchemas(v1, [
      { name: "id", type: "string", nullable: false },
      { name: "name", type: "string", nullable: false },
    ]);
    expect(diff.classification).toBe("BREAKING");
    expect(formatSchemaDiff(diff)).toContain("BREAKING");
  });

  it("worstClassification is order independent", () => {
    expect(worstClassification(["WARNING", "COMPATIBLE", "BREAKING"])).toBe("BREAKING");
    expect(worstClassification(["COMPATIBLE"])).toBe("COMPATIBLE");
    expect(worstClassification([])).toBe("COMPATIBLE");
  });
});

class FakeStore implements SchemaStore {
  private readonly rows: DataSchema[] = [];
  async latestSchema(_org: string, dataset: string): Promise<DataSchema | null> {
    return this.rows.filter((s) => s.dataset === dataset).sort((a, b) => b.version - a.version)[0] ?? null;
  }
  async listSchemaVersions(_org: string, dataset: string): Promise<DataSchema[]> {
    return this.rows.filter((s) => s.dataset === dataset).sort((a, b) => a.version - b.version);
  }
  async insertSchema(_org: string, schema: DataSchema): Promise<DataSchema> {
    this.rows.push(schema);
    return schema;
  }
}

describe("SchemaRegistry", () => {
  it("creates v1 then v2 and reports the diff", async () => {
    const registry = new SchemaRegistry(new FakeStore());
    const first = await registry.register("org_1", "customers", [
      { name: "id", type: "integer", nullable: false },
      { name: "name", type: "string", nullable: false },
    ]);
    expect(first.schema.version).toBe(1);
    expect(first.created).toBe(true);
    expect(first.diff).toBeNull();

    const second = await registry.register("org_1", "customers", [
      { name: "id", type: "integer", nullable: false },
      { name: "name", type: "string", nullable: false },
      { name: "country", type: "string", nullable: true },
    ]);
    expect(second.schema.version).toBe(2);
    expect(second.diff?.classification).toBe("COMPATIBLE");
    expect(await registry.versions("org_1", "customers")).toHaveLength(2);
  });

  it("does not create a new version for an identical schema", async () => {
    const registry = new SchemaRegistry(new FakeStore());
    const columns: ColumnSchema[] = [{ name: "id", type: "integer", nullable: false }];
    await registry.register("org_1", "d", columns);
    const again = await registry.register("org_1", "d", [...columns]);
    expect(again.created).toBe(false);
    expect(again.schema.version).toBe(1);
  });

  it("checks observed rows against the registered contract", async () => {
    const registry = new SchemaRegistry(new FakeStore());
    await registry.register("org_1", "sales", [
      { name: "id", type: "integer", nullable: false },
      { name: "amount", type: "float", nullable: false },
    ]);
    const result = await registry.check("org_1", "sales", [{ id: 1 }]);
    expect(result.diff?.classification).toBe("BREAKING");
    expect(result.observed).toHaveLength(1);
  });

  it("fingerprints column sets independently of order", () => {
    const a: ColumnSchema[] = [{ name: "a", type: "integer", nullable: false }, { name: "b", type: "string", nullable: true }];
    expect(fingerprintColumns(a)).toBe(fingerprintColumns([...a].reverse()));
    expect(fingerprintColumns(a)).not.toBe(fingerprintColumns([{ name: "a", type: "string", nullable: false }]));
  });
});
