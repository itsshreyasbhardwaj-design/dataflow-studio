import { describe, expect, it } from "vitest";
import { backoffSchedule, classifyError, isRetryableError, planRetry } from "./retry.js";
import type { RetryPolicy, WorkflowNode } from "./types.js";

const node = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: "t",
  type: "filter.transform",
  config: { predicates: [] },
  ...overrides,
});

describe("backoffSchedule", () => {
  it("computes the documented exponential schedule", () => {
    const policy: RetryPolicy = { maxAttempts: 4, strategy: "exponential", initialDelaySeconds: 5, multiplier: 6, maxDelaySeconds: 900 };
    expect(backoffSchedule(policy)).toEqual([5, 30, 180]);
  });

  it("clamps at maxDelaySeconds", () => {
    const policy: RetryPolicy = { maxAttempts: 6, strategy: "exponential", initialDelaySeconds: 10, multiplier: 10, maxDelaySeconds: 120 };
    expect(backoffSchedule(policy)).toEqual([10, 100, 120, 120, 120]);
  });

  it("supports fixed backoff", () => {
    expect(backoffSchedule({ maxAttempts: 3, strategy: "fixed", initialDelaySeconds: 7 })).toEqual([7, 7]);
  });

  it("supports explicit backoff and repeats the last delay", () => {
    expect(backoffSchedule({ maxAttempts: 4, strategy: "explicit", delaysSeconds: [1, 2] })).toEqual([1, 2, 2]);
  });

  it("returns an empty schedule when retries are disabled", () => {
    expect(backoffSchedule({ maxAttempts: 1, strategy: "fixed" })).toEqual([]);
  });
});

describe("planRetry", () => {
  const policy: RetryPolicy = { maxAttempts: 3, strategy: "exponential", initialDelaySeconds: 5, multiplier: 6 };

  it("retries a transient failure with the right delay", () => {
    const decision = planRetry(node({ retry: policy }), 1, "timeout");
    expect(decision).toMatchObject({ retry: true, delaySeconds: 5 });
    expect(planRetry(node({ retry: policy }), 2, "timeout").delaySeconds).toBe(30);
  });

  it("stops once the budget is exhausted", () => {
    const decision = planRetry(node({ retry: policy }), 3, "timeout");
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/Exhausted retry budget/);
  });

  it("never retries a non-retryable error class", () => {
    expect(planRetry(node({ retry: policy }), 1, "validation").retry).toBe(false);
    expect(planRetry(node({ retry: policy }), 1, "permission").retry).toBe(false);
    expect(planRetry(node({ retry: policy }), 1, "data_quality").retry).toBe(false);
  });

  it("never retries a cancellation", () => {
    expect(planRetry(node({ retry: policy }), 1, "cancelled")).toMatchObject({ retry: false });
  });

  it("refuses to retry a destructive write that is not idempotent", () => {
    const destination = node({
      type: "postgres.destination",
      config: { connectionId: "c", table: "t", writeMode: "append", idempotent: false },
      retry: policy,
    });
    const decision = planRetry(destination, 1, "connection");
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/destructive write/);
  });

  it("retries a destructive write that declares itself idempotent", () => {
    const destination = node({
      type: "postgres.destination",
      config: { connectionId: "c", table: "t", writeMode: "upsert", idempotent: true },
      retry: policy,
    });
    expect(planRetry(destination, 1, "connection").retry).toBe(true);
  });

  it("honours an explicit nonRetryableErrors list", () => {
    const strict: RetryPolicy = { ...policy, nonRetryableErrors: ["timeout"] };
    expect(planRetry(node({ retry: strict }), 1, "timeout").retry).toBe(false);
    expect(isRetryableError(strict, "connection")).toBe(true);
  });

  it("falls back to the workflow default policy", () => {
    expect(planRetry(node(), 1, "timeout", { maxAttempts: 2, strategy: "fixed", initialDelaySeconds: 3 }))
      .toMatchObject({ retry: true, delaySeconds: 3 });
  });
});

describe("classifyError", () => {
  it.each([
    ["ETIMEDOUT reading from socket", "timeout"],
    ["connect ECONNREFUSED 127.0.0.1:5432", "connection"],
    ["429 Too Many Requests", "rate_limit"],
    ["503 Service Unavailable", "transient"],
    ["could not serialize access due to concurrent update", "transient"],
    ["403 Forbidden: insufficient privileges", "permission"],
    ['relation "sales" does not exist', "not_found"],
    ["column amount must be numeric", "validation"],
    ["quality gate blocked downstream execution", "data_quality"],
    ["something entirely novel happened", "unknown"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it("prefers an explicit errorClass property", () => {
    expect(classifyError(Object.assign(new Error("boom"), { errorClass: "rate_limit" }))).toBe("rate_limit");
  });

  it("uses the error code when the message is unhelpful", () => {
    expect(classifyError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe("connection");
  });
});
