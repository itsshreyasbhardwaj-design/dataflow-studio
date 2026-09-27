import { describe, expect, it } from "vitest";
import { inferSchema, makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import { applyFilter, evaluatePredicate, parsePredicates, TransformConfigError } from "./filter.js";
import { applyAggregate, parseMeasures } from "./aggregate.js";
import { applyJoin, estimateJoinCardinality, parseJoinKeys } from "./join.js";

const batch = (rows: Array<Record<string, unknown>>): DataBatch => makeBatch(rows, inferSchema(rows));

const SALES = batch([
  { id: 1, customer_id: "c1", region: "north", amount: 100, note: "Priority order" },
  { id: 2, customer_id: null, region: "north", amount: 50, note: "walk-in" },
  { id: 3, customer_id: "c2", region: "south", amount: 0, note: null },
  { id: 4, customer_id: "c3", region: "east", amount: -5, note: "refund" },
]);

describe("parsePredicates", () => {
  it("parses a valid list", () => {
    expect(parsePredicates([{ column: "a", op: "gte", value: 1 }])).toEqual([{ column: "a", op: "gte", value: 1 }]);
  });

  it("rejects malformed entries", () => {
    expect(() => parsePredicates("nope")).toThrow(/must be an array/);
    expect(() => parsePredicates([1])).toThrow(/must be an object/);
    expect(() => parsePredicates([{ op: "eq" }])).toThrow(/column must be a non-empty string/);
    expect(() => parsePredicates([{ column: "a", op: "spaceship" }])).toThrow(/op must be one of/);
    expect(() => parsePredicates([{ column: "a", op: "in", value: 1 }])).toThrow(/requires an array value/);
    expect(() => parsePredicates([{ column: "a", op: "between", value: 1 }])).toThrow(/requires `value` and `high`/);
  });

  it("rejects an invalid or oversized regex at configuration time", () => {
    expect(() => parsePredicates([{ column: "a", op: "matches", value: "([" }])).toThrow(/pattern is invalid/);
    expect(() => parsePredicates([{ column: "a", op: "matches", value: "a".repeat(600) }])).toThrow(/exceeds 512/);
    expect(() => parsePredicates([{ column: "a", op: "matches", value: 5 }])).toThrow(/string pattern/);
  });
});

describe("evaluatePredicate", () => {
  const row = { n: 10, s: "Hello World", z: null };
  it.each([
    [{ column: "n", op: "eq", value: 10 }, true],
    [{ column: "n", op: "eq", value: "10" }, true],
    [{ column: "n", op: "ne", value: 11 }, true],
    [{ column: "n", op: "gt", value: 9 }, true],
    [{ column: "n", op: "lte", value: 10 }, true],
    [{ column: "n", op: "in", value: [1, 10] }, true],
    [{ column: "n", op: "not_in", value: [1, 2] }, true],
    [{ column: "n", op: "between", value: 5, high: 15 }, true],
    [{ column: "z", op: "null" }, true],
    [{ column: "n", op: "not_null" }, true],
    [{ column: "s", op: "contains", value: "World" }, true],
    [{ column: "s", op: "contains", value: "world" }, false],
    [{ column: "s", op: "contains", value: "world", caseInsensitive: true }, true],
    [{ column: "s", op: "starts_with", value: "Hello" }, true],
    [{ column: "s", op: "ends_with", value: "World" }, true],
    [{ column: "s", op: "matches", value: "^H.*d$" }, true],
    [{ column: "s", op: "not_contains", value: "xyz" }, true],
  ])("%j", (predicate, expected) => {
    expect(evaluatePredicate(predicate as never, row)).toBe(expected);
  });

  it("never passes a NULL for comparison operators", () => {
    for (const op of ["eq", "ne", "gt", "gte", "lt", "lte", "not_in", "contains", "matches"]) {
      expect(evaluatePredicate({ column: "z", op, value: [1] } as never, row)).toBe(false);
    }
  });
});

describe("applyFilter", () => {
  it("keeps matching rows with AND", () => {
    const result = applyFilter(SALES, {
      predicates: parsePredicates([{ column: "customer_id", op: "not_null" }, { column: "amount", op: "gte", value: 0 }]),
    });
    expect(result.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(result.rowCount).toBe(2);
  });

  it("supports OR", () => {
    const result = applyFilter(SALES, {
      predicates: parsePredicates([{ column: "region", op: "eq", value: "east" }, { column: "amount", op: "gt", value: 60 }]),
      combine: "or",
    });
    expect(result.rows.map((r) => r.id)).toEqual([1, 4]);
  });

  it("returns the input untouched when there are no predicates", () => {
    expect(applyFilter(SALES, { predicates: [] })).toBe(SALES);
  });

  it("re-infers the schema of the surviving rows", () => {
    const result = applyFilter(SALES, { predicates: parsePredicates([{ column: "id", op: "eq", value: 1 }]) });
    expect(result.columns.find((c) => c.name === "customer_id")?.nullable).toBe(false);
  });

  it("fails loudly on an unknown column instead of dropping every row", () => {
    expect(() => applyFilter(SALES, { predicates: parsePredicates([{ column: "ghost", op: "not_null" }]) }))
      .toThrow(/not present in the input/);
  });

  it("tolerates an unknown column when the input is empty", () => {
    expect(applyFilter(batch([]), { predicates: parsePredicates([{ column: "ghost", op: "not_null" }]) }).rowCount).toBe(0);
  });
});

describe("parseMeasures", () => {
  it("defaults the output name", () => {
    expect(parseMeasures([{ column: "amount", fn: "sum" }])).toEqual([{ column: "amount", fn: "sum", as: "sum_amount" }]);
  });
  it("requires a column for everything but count", () => {
    expect(() => parseMeasures([{ fn: "sum" }])).toThrow(/requires a column/);
    expect(parseMeasures([{ fn: "count" }])).toEqual([{ fn: "count", as: "count" }]);
  });
  it("rejects an unknown function and an empty list", () => {
    expect(() => parseMeasures([{ column: "a", fn: "median" }])).toThrow(/must be one of/);
    expect(() => parseMeasures([])).toThrow(/non-empty array/);
  });
});

describe("applyAggregate", () => {
  it("groups and computes measures", () => {
    const result = applyAggregate(SALES, {
      groupBy: ["region"],
      measures: parseMeasures([
        { fn: "count", as: "orders" },
        { column: "amount", fn: "sum", as: "revenue" },
        { column: "amount", fn: "avg", as: "avg_amount" },
        { column: "customer_id", fn: "count_distinct", as: "customers" },
      ]),
    });
    expect(result.rows).toEqual([
      { region: "north", orders: 2, revenue: 150, avg_amount: 75, customers: 1 },
      { region: "south", orders: 1, revenue: 0, avg_amount: 0, customers: 1 },
      { region: "east", orders: 1, revenue: -5, avg_amount: -5, customers: 1 },
    ]);
  });

  it("aggregates the whole batch when groupBy is empty", () => {
    const result = applyAggregate(SALES, { measures: parseMeasures([{ column: "amount", fn: "max", as: "peak" }]) });
    expect(result.rows).toEqual([{ peak: 100 }]);
  });

  it("returns null measures for an empty group rather than zero", () => {
    const result = applyAggregate(batch([]), { measures: parseMeasures([{ column: "amount", fn: "sum", as: "revenue" }, { fn: "count", as: "n" }]) });
    expect(result.rows).toEqual([{ revenue: null, n: 0 }]);
  });

  it("supports first and last", () => {
    const result = applyAggregate(SALES, { groupBy: ["region"], measures: parseMeasures([{ column: "id", fn: "first", as: "f" }, { column: "id", fn: "last", as: "l" }]) });
    expect(result.rows[0]).toEqual({ region: "north", f: 1, l: 2 });
  });

  it("rejects an unknown column and non-numeric sums", () => {
    expect(() => applyAggregate(SALES, { groupBy: ["ghost"], measures: parseMeasures([{ fn: "count", as: "n" }]) }))
      .toThrow(/unknown column "ghost"/);
    expect(() => applyAggregate(SALES, { measures: parseMeasures([{ column: "region", fn: "sum", as: "s" }]) }))
      .toThrow(/non-numeric/);
  });
});

describe("applyJoin", () => {
  const customers = batch([
    { id: "c1", name: "Ada" },
    { id: "c2", name: "Grace" },
    { id: "c9", name: "Alan" },
  ]);
  const on = parseJoinKeys([{ left: "customer_id", right: "id" }]);

  it("inner joins", () => {
    const result = applyJoin(SALES, customers, { on, type: "inner" });
    expect(result.rows.map((r) => [r.id, r.name])).toEqual([[1, "Ada"], [3, "Grace"]]);
  });

  it("renames colliding right-side columns", () => {
    const result = applyJoin(SALES, customers, { on, type: "inner" });
    expect(result.columns.map((c) => c.name)).toContain("right_id");
    expect(result.rows[0]!["right_id"]).toBe("c1");
    expect(result.rows[0]!["id"]).toBe(1);
  });

  it("honours a custom right prefix", () => {
    const result = applyJoin(SALES, customers, { on, type: "inner", rightPrefix: "cust_" });
    expect(result.columns.map((c) => c.name)).toContain("cust_id");
  });

  it("left joins with NULLs for unmatched rows", () => {
    const result = applyJoin(SALES, customers, { on, type: "left" });
    expect(result.rowCount).toBe(4);
    expect(result.rows.find((r) => r.id === 2)).toMatchObject({ name: null });
  });

  it("right joins keeping unmatched right rows", () => {
    const result = applyJoin(SALES, customers, { on, type: "right" });
    expect(result.rows.filter((r) => r.name === "Alan")).toEqual([{ id: null, customer_id: null, region: null, amount: null, note: null, right_id: "c9", name: "Alan" }]);
  });

  it("full joins both sides including NULL keys", () => {
    const result = applyJoin(SALES, customers, { on, type: "full" });
    // 2 matches + 2 unmatched left + 1 unmatched right
    expect(result.rowCount).toBe(5);
  });

  it("never matches on NULL keys", () => {
    const left = batch([{ k: null, v: 1 }]);
    const right = batch([{ k: null, w: 2 }]);
    expect(applyJoin(left, right, { on: parseJoinKeys([{ left: "k", right: "k" }]), type: "inner" }).rowCount).toBe(0);
  });

  it("supports composite keys", () => {
    const left = batch([{ a: 1, b: "x", v: "keep" }, { a: 1, b: "y", v: "drop" }]);
    const right = batch([{ a: 1, b: "x", w: 9 }]);
    const result = applyJoin(left, right, { on: parseJoinKeys([{ left: "a", right: "a" }, { left: "b", right: "b" }]) });
    expect(result.rows).toEqual([{ a: 1, b: "x", v: "keep", right_a: 1, right_b: "x", w: 9 }]);
  });

  it("rejects unknown join keys", () => {
    expect(() => applyJoin(SALES, customers, { on: parseJoinKeys([{ left: "ghost", right: "id" }]) }))
      .toThrow(/"ghost" is not present on the left input/);
    expect(() => applyJoin(SALES, customers, { on: parseJoinKeys([{ left: "customer_id", right: "ghost" }]) }))
      .toThrow(/"ghost" is not present on the right input/);
  });

  it("guards against a runaway fan-out", () => {
    const many = batch(Array.from({ length: 50 }, () => ({ k: 1 })));
    expect(() => applyJoin(many, many, { on: parseJoinKeys([{ left: "k", right: "k" }]), maxOutputRows: 100 }))
      .toThrow(/more than 100 rows/);
  });

  it("estimates cardinality for the editor", () => {
    expect(estimateJoinCardinality(SALES, customers, on)).toBe(2);
  });

  it("rejects malformed key pairs", () => {
    expect(() => parseJoinKeys([])).toThrow(/non-empty array/);
    expect(() => parseJoinKeys([{ left: "a" }])).toThrow(/string `left` and `right`/);
  });
});

describe("TransformConfigError", () => {
  it("classifies as a configuration error so the executor does not retry it", () => {
    expect(new TransformConfigError("x").errorClass).toBe("configuration");
  });
});
