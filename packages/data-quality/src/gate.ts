import type { QualityResult } from "./types.js";
import { summarize } from "./checks.js";

export type GateSeverity = "any_failure" | "error_only" | "score_below";

export interface GateConfig {
  severity?: GateSeverity;
  minScore?: number;
  scope?: "upstream" | "run";
}

export interface GateDecision {
  /** True when downstream nodes must be marked BLOCKED. */
  blocked: boolean;
  reason: string;
  failedChecks: string[];
  score: number;
  evaluatedChecks: number;
}

/**
 * Decides whether downstream execution proceeds. The decision is explicit and
 * recorded on the run: a blocked load is a deliberate outcome, not a crash.
 */
export function evaluateGate(results: readonly QualityResult[], config: GateConfig = {}): GateDecision {
  const severity = config.severity ?? "any_failure";
  const summary = summarize(results);
  const failing = results.filter((r) => r.status !== "PASSED");
  const failingErrors = failing.filter((r) => r.severity === "error");

  if (results.length === 0) {
    return {
      blocked: false,
      reason: "No quality results in scope; nothing to gate on",
      failedChecks: [],
      score: 1,
      evaluatedChecks: 0,
    };
  }

  switch (severity) {
    case "any_failure":
      return {
        blocked: failing.length > 0,
        reason: failing.length
          ? `${failing.length} of ${results.length} quality check(s) did not pass: ${failing.map((r) => r.checkId).join(", ")}`
          : `All ${results.length} quality check(s) passed`,
        failedChecks: failing.map((r) => r.checkId),
        score: summary.score,
        evaluatedChecks: results.length,
      };
    case "error_only":
      return {
        blocked: failingErrors.length > 0,
        reason: failingErrors.length
          ? `${failingErrors.length} error-severity check(s) did not pass: ${failingErrors.map((r) => r.checkId).join(", ")}`
          : `No error-severity failures (${failing.length} warning(s))`,
        failedChecks: failingErrors.map((r) => r.checkId),
        score: summary.score,
        evaluatedChecks: results.length,
      };
    case "score_below": {
      const minScore = config.minScore ?? 1;
      const blocked = summary.score < minScore;
      return {
        blocked,
        reason: blocked
          ? `Quality score ${(summary.score * 100).toFixed(2)}% is below the required ${(minScore * 100).toFixed(2)}%`
          : `Quality score ${(summary.score * 100).toFixed(2)}% meets the required ${(minScore * 100).toFixed(2)}%`,
        failedChecks: blocked ? failing.map((r) => r.checkId) : [],
        score: summary.score,
        evaluatedChecks: results.length,
      };
    }
  }
}
