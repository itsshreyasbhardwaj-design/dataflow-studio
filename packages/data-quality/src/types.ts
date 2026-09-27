export const CHECK_TYPES = [
  "not_null",
  "unique",
  "range",
  "regex",
  "accepted_values",
  "row_count",
  "freshness",
  "custom_sql",
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export type CheckSeverity = "error" | "warn";
export type CheckStatus = "PASSED" | "FAILED" | "ERRORED";

export interface QualityCheck {
  /** Stable identifier. Results are keyed by it across runs, so it must not change. */
  id: string;
  type: CheckType;
  column?: string;
  /**
   * Fraction of rows that must pass, between 0 and 1. Defaults to 1 (every row).
   * Setting 0.99 is how a team tolerates known dirty data without muting the check.
   */
  threshold?: number;
  severity?: CheckSeverity;
  description?: string;

  // not_null / unique need nothing beyond `column`.
  // range
  min?: number;
  max?: number;
  // regex
  pattern?: string;
  caseInsensitive?: boolean;
  // accepted_values
  values?: unknown[];
  // row_count
  minRows?: number;
  maxRows?: number;
  // freshness
  maxAgeSeconds?: number;
  // custom_sql: a SELECT that returns the rows which VIOLATE the expectation.
  sql?: string;
}

export interface QualityResult {
  checkId: string;
  type: CheckType;
  column?: string;
  status: CheckStatus;
  severity: CheckSeverity;
  /** Human-readable expectation, e.g. "NOT NULL, expected 100%". */
  expected: string;
  /** What we actually observed, e.g. "99.4%". */
  actual: string;
  passedRows: number;
  failedRows: number;
  totalRows: number;
  /** passedRows / totalRows, 1 when there is nothing to check. */
  passRate: number;
  /** Up to 5 offending values, for the run page. Never includes whole rows. */
  failedSamples: unknown[];
  message: string;
  /** Set when the check itself could not be evaluated. */
  error?: string;
  durationMs: number;
}

export interface QualitySummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** Mean pass rate across checks, 1 when there are no checks. */
  score: number;
  /** True when any check with severity `error` failed or errored. */
  blocking: boolean;
}
