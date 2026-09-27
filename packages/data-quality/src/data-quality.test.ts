import { describe, expect, it } from "vitest";
import { inferSchema, makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import { formatResult, parseChecks, QualityConfigError, runChecks, summarize } from "./checks.js";
import { evaluateGate } from "./gate.js";
import type { QualityCheck, QualityResult } from "./types.js";

const batch = (rows: Array<Record<string, unknown>>): DataBatch => makeBatch(rows, inferSchema(rows));

const NOW = new Date("2026-03-31T12:00:00Z");

const CUSTOMERS = batch([
  { customer_id: "c1", email: "ada@example.com", revenue: 100, region: "north", updated_at: "2026-03-31T11:00:00Z" },
  { customer_id: "c2", email: "grace@example.com", revenue: 0, region: "south", updated_at: "2026-03-31T10:00:00Z" },
  { customer_id: "c3", email: "not-an-email", revenue: -5, region: "west", updated_at: "2026-03-30T12:00:00Z" },
  { customer_id: null, email: "alan@example.com", revenue: 50, region: "mars", updated_at: "2026-03-29T12:00:00Z" },
  { customer_id: "c1", email: "ada@example.com", revenue: 20, region: "north", updated_at: "2026-03-28T12:00:00Z" },
]);

const run = (checks: unknown, input: DataBatch = CUSTOMERS): QualityResult[] =>
  runChecks(input, parseChecks(checks), { now: NOW });

describe("parseChecks", () => {
  it("parses a valid list", () => {
    expect(parseChecks([{ id: "a", type: "not_null", column: "x" }])[0]).toMatchObject({ id: "a", type: "not_null" });
  });

  it("requires a column for column-level checks", () => {
    expect(() => parseChecks([{ id: "a", type: "not_null" }])).toThrow(/requires a column/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseChecks([{ id: "a", type: "row_count", minRows: 1 }, { id: "a", type: "row_count", minRows: 1 }]))
      .toThrow(/Duplicate check id/);
  });

  it("validates each check's own required fields", () => {
    expect(() => parseChecks([{ id: "a", type: "range", column: "x" }])).toThrow(/requires min and\/or max/);
    expect(() => parseChecks([{ id: "a", type: "regex", column: "x" }])).toThrow(/requires a pattern/);
    expect(() => parseChecks([{ id: "a", type: "accepted_values", column: "x" }])).toThrow(/non-empty values array/);
    expect(() => parseChecks([{ id: "a", type: "row_count" }])).toThrow(/requires minRows/);
    expect(() => parseChecks([{ id: "a", type: "freshness", column: "x" }])).toThrow(/requires maxAgeSeconds/);
    expect(() => parseChecks([{ id: "a", type: "custom_sql" }])).toThrow(/requires a sql query/);
    expect(() => parseChecks([{ id: "a", type: "nonsense", column: "x" }])).toThrow(/must be one of/);
  });

  it("validates threshold and severity", () => {
    expect(() => parseChecks([{ id: "a", type: "not_null", column: "x", threshold: 1.5 }])).toThrow(/between 0 and 1/);
    expect(() => parseChecks([{ id: "a", type: "not_null", column: "x", severity: "critical" }])).toThrow(/must be "error" or "warn"/);
  });

  it("rejects an invalid regex at configuration time", () => {
    expect(() => parseChecks([{ id: "a", type: "regex", column: "x", pattern: "([" }])).toThrow(QualityConfigError);
  });

  it("accepts min/max as aliases for row_count bounds", () => {
    expect(parseChecks([{ id: "a", type: "row_count", min: 1, max: 9 }])[0]).toMatchObject({ minRows: 1, maxRows: 9 });
  });
});

describe("not_null", () => {
  it("reports the documented partial failure", () => {
    const [result] = run([{ id: "customer_id_not_null", type: "not_null", column: "customer_id" }]);
    expect(result).toMatchObject({
      checkId: "customer_id_not_null",
      column: "customer_id",
      status: "FAILED",
      passedRows: 4,
      failedRows: 1,
      totalRows: 5,
      expected: "NOT NULL, expected 100%",
      actual: "80%",
    });
    expect(formatResult(result!)).toContain("Status: FAILED");
  });

  it("passes when a threshold tolerates the failures", () => {
    const [result] = run([{ id: "c", type: "not_null", column: "customer_id", threshold: 0.8 }]);
    expect(result!.status).toBe("PASSED");
  });

  it("treats an empty batch as passing with nothing to check", () => {
    const [result] = run([{ id: "c", type: "not_null", column: "customer_id" }], batch([]));
    expect(result).toMatchObject({ status: "PASSED", totalRows: 0, passRate: 1, message: "No rows to check" });
  });

  it("reports 99.4% for a realistic large dataset", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ customer_id: i < 6 ? null : `c${i}` }));
    const [result] = run([{ id: "c", type: "not_null", column: "customer_id" }], batch(rows));
    expect(result!.actual).toBe("99.4%");
  });
});

describe("unique", () => {
  it("counts every row sharing a duplicated value", () => {
    const [result] = run([{ id: "u", type: "unique", column: "customer_id" }]);
    expect(result).toMatchObject({ status: "FAILED", failedRows: 2, passedRows: 3 });
    expect(result!.failedSamples).toEqual(["c1"]);
  });

  it("ignores NULLs, as a UNIQUE constraint does", () => {
    const [result] = run([{ id: "u", type: "unique", column: "email" }], batch([{ email: null }, { email: null }, { email: "a" }]));
    expect(result!.status).toBe("PASSED");
  });
});

describe("range", () => {
  it("fails values below the minimum", () => {
    const [result] = run([{ id: "r", type: "range", column: "revenue", min: 0 }]);
    expect(result).toMatchObject({ status: "FAILED", failedRows: 1 });
    expect(result!.failedSamples).toEqual([-5]);
  });

  it("passes when all values are inside the bounds", () => {
    expect(run([{ id: "r", type: "range", column: "revenue", min: -10, max: 1000 }])[0]!.status).toBe("PASSED");
  });

  it("does not police NULLs - that is not_null's job", () => {
    const [result] = run([{ id: "r", type: "range", column: "revenue", min: 0 }], batch([{ revenue: null }]));
    expect(result!.status).toBe("PASSED");
  });

  it("fails non-numeric values", () => {
    const [result] = run([{ id: "r", type: "range", column: "revenue", min: 0 }], batch([{ revenue: "abc" }]));
    expect(result!.status).toBe("FAILED");
  });
});

describe("regex and accepted_values", () => {
  it("validates an email pattern", () => {
    const [result] = run([{ id: "e", type: "regex", column: "email", pattern: "^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$" }]);
    expect(result).toMatchObject({ status: "FAILED", failedRows: 1 });
    expect(result!.failedSamples).toEqual(["not-an-email"]);
  });

  it("supports case-insensitive patterns", () => {
    const [result] = run([{ id: "e", type: "regex", column: "region", pattern: "^NORTH$", caseInsensitive: true }], batch([{ region: "north" }]));
    expect(result!.status).toBe("PASSED");
  });

  it("enforces accepted values", () => {
    const [result] = run([{ id: "v", type: "accepted_values", column: "region", values: ["north", "south", "east", "west"] }]);
    expect(result).toMatchObject({ status: "FAILED", failedRows: 1 });
    expect(result!.failedSamples).toEqual(["mars"]);
    expect(result!.expected).toContain("IN (north, south, east, west)");
  });
});

describe("row_count", () => {
  it("passes within bounds and fails outside", () => {
    expect(run([{ id: "n", type: "row_count", minRows: 1 }])[0]!.status).toBe("PASSED");
    expect(run([{ id: "n", type: "row_count", minRows: 10 }])[0]).toMatchObject({ status: "FAILED", actual: "5" });
    expect(run([{ id: "n", type: "row_count", maxRows: 2 }])[0]!.status).toBe("FAILED");
  });

  it("fails an empty batch when rows are required", () => {
    expect(run([{ id: "n", type: "row_count", minRows: 1 }], batch([]))[0]!.status).toBe("FAILED");
  });
});

describe("freshness", () => {
  it("passes when the newest row is inside the window", () => {
    const [result] = run([{ id: "f", type: "freshness", column: "updated_at", maxAgeSeconds: 7200 }]);
    expect(result).toMatchObject({ status: "PASSED", actual: "3600s old" });
  });

  it("fails when the data is stale", () => {
    const [result] = run([{ id: "f", type: "freshness", column: "updated_at", maxAgeSeconds: 60 }]);
    expect(result!.status).toBe("FAILED");
    expect(result!.message).toMatch(/Data is stale/);
  });

  it("fails when no timestamp can be parsed", () => {
    const [result] = run([{ id: "f", type: "freshness", column: "updated_at", maxAgeSeconds: 60 }], batch([{ updated_at: "not a date" }]));
    expect(result!.message).toMatch(/No parsable timestamp/);
  });
});

describe("custom_sql", () => {
  it("passes when the violation query returns no rows", () => {
    const [result] = run([{ id: "s", type: "custom_sql", sql: "SELECT customer_id FROM input WHERE revenue < -1000" }]);
    expect(result).toMatchObject({ status: "PASSED", failedRows: 0, message: "No violations" });
  });

  it("fails and samples the violating rows", () => {
    const [result] = run([{ id: "s", type: "custom_sql", sql: "SELECT customer_id, revenue FROM input WHERE revenue < 0" }]);
    expect(result).toMatchObject({ status: "FAILED", failedRows: 1 });
    expect(result!.failedSamples).toEqual([{ customer_id: "c3", revenue: -5 }]);
  });

  it("errors rather than crashing when the SQL is invalid", () => {
    const [result] = run([{ id: "s", type: "custom_sql", sql: "DELETE FROM input" }]);
    expect(result!.status).toBe("ERRORED");
    expect(result!.error).toMatch(/Expected SELECT/);
  });
});

describe("error handling", () => {
  it("errors a check against a missing column instead of silently passing", () => {
    const [result] = run([{ id: "c", type: "not_null", column: "ghost" }]);
    expect(result!.status).toBe("ERRORED");
    expect(result!.message).toMatch(/not present in the input/);
  });

  it("keeps evaluating later checks after one errors", () => {
    const results = run([
      { id: "bad", type: "not_null", column: "ghost" },
      { id: "good", type: "row_count", minRows: 1 },
    ]);
    expect(results.map((r) => r.status)).toEqual(["ERRORED", "PASSED"]);
  });
});

describe("summarize", () => {
  it("aggregates counts, score and blocking status", () => {
    const results = run([
      { id: "a", type: "row_count", minRows: 1 },
      { id: "b", type: "not_null", column: "customer_id" },
      { id: "c", type: "not_null", column: "customer_id", severity: "warn" },
    ]);
    const summary = summarize(results);
    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 2, errored: 0, blocking: true });
    expect(summary.score).toBeCloseTo((1 + 0.8 + 0.8) / 3, 5);
  });

  it("is not blocking when only warnings fail", () => {
    const results = run([{ id: "b", type: "not_null", column: "customer_id", severity: "warn" }]);
    expect(summarize(results).blocking).toBe(false);
  });

  it("scores an empty check list as perfect", () => {
    expect(summarize([])).toMatchObject({ score: 1, blocking: false, total: 0 });
  });
});

describe("evaluateGate", () => {
  const failing = run([{ id: "b", type: "not_null", column: "customer_id" }]);
  const warning = run([{ id: "w", type: "not_null", column: "customer_id", severity: "warn" }]);
  const passing = run([{ id: "a", type: "row_count", minRows: 1 }]);

  it("blocks on any failure by default", () => {
    const decision = evaluateGate(failing);
    expect(decision.blocked).toBe(true);
    expect(decision.failedChecks).toEqual(["b"]);
    expect(decision.reason).toMatch(/1 of 1 quality check\(s\) did not pass/);
  });

  it("allows a clean run", () => {
    expect(evaluateGate(passing).blocked).toBe(false);
  });

  it("ignores warnings in error_only mode", () => {
    expect(evaluateGate(warning, { severity: "error_only" }).blocked).toBe(false);
    expect(evaluateGate(failing, { severity: "error_only" }).blocked).toBe(true);
  });

  it("compares against a minimum score", () => {
    expect(evaluateGate(failing, { severity: "score_below", minScore: 0.9 }).blocked).toBe(true);
    expect(evaluateGate(failing, { severity: "score_below", minScore: 0.7 }).blocked).toBe(false);
    expect(evaluateGate(failing, { severity: "score_below", minScore: 0.9 }).reason).toMatch(/80.00% is below the required 90.00%/);
  });

  it("does not block when there is nothing in scope", () => {
    const decision = evaluateGate([]);
    expect(decision).toMatchObject({ blocked: false, evaluatedChecks: 0 });
    expect(decision.reason).toMatch(/nothing to gate on/);
  });

  it("blocks on an errored check, because an unevaluated expectation is not a pass", () => {
    const errored = run([{ id: "c", type: "not_null", column: "ghost" }]);
    expect(evaluateGate(errored).blocked).toBe(true);
  });
});

describe("QualityCheck typing", () => {
  it("accepts a fully specified check object", () => {
    const check: QualityCheck = { id: "x", type: "range", column: "revenue", min: 0, max: 10, threshold: 0.99, severity: "warn" };
    expect(runChecks(CUSTOMERS, [check], { now: NOW })[0]!.severity).toBe("warn");
  });
});
