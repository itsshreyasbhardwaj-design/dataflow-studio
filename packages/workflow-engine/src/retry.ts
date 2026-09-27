import {
  DEFAULT_RETRY_POLICY,
  RETRYABLE_ERROR_CLASSES,
  type ErrorClass,
  type RetryPolicy,
} from "./types.js";
import { getNodeType } from "./node-types.js";
import type { WorkflowNode } from "./types.js";

export interface RetryDecision {
  retry: boolean;
  delaySeconds: number;
  reason: string;
}

export function resolveRetryPolicy(node: WorkflowNode, fallback?: RetryPolicy): RetryPolicy {
  return node.retry ?? fallback ?? DEFAULT_RETRY_POLICY;
}

/** The full backoff schedule, so the UI can show it without reimplementing it. */
export function backoffSchedule(policy: RetryPolicy): number[] {
  const delays: number[] = [];
  const max = policy.maxDelaySeconds ?? 3600;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    delays.push(computeDelay(policy, attempt, max));
  }
  return delays;
}

function computeDelay(policy: RetryPolicy, attempt: number, max: number): number {
  switch (policy.strategy) {
    case "explicit": {
      const explicit = policy.delaysSeconds ?? [];
      const value = explicit[attempt - 1] ?? explicit.at(-1) ?? 0;
      return Math.min(value, max);
    }
    case "fixed":
      return Math.min(policy.initialDelaySeconds ?? 5, max);
    case "exponential":
    default: {
      const base = policy.initialDelaySeconds ?? 5;
      const multiplier = policy.multiplier ?? 2;
      return Math.min(base * Math.pow(multiplier, attempt - 1), max);
    }
  }
}

export function isRetryableError(policy: RetryPolicy, errorClass: ErrorClass): boolean {
  if (policy.nonRetryableErrors?.includes(errorClass)) return false;
  const allowed = policy.retryableErrors ?? RETRYABLE_ERROR_CLASSES;
  return (allowed as readonly string[]).includes(errorClass);
}

/**
 * Decides whether a failed attempt gets another go.
 *
 * `attempt` is 1-based and refers to the attempt that just failed. A destructive
 * node (one that writes to an external system) is never retried unless it has
 * explicitly declared the write idempotent - re-running a non-idempotent COPY
 * into a warehouse is how you get double-counted revenue.
 */
export function planRetry(
  node: WorkflowNode,
  attempt: number,
  errorClass: ErrorClass,
  fallback?: RetryPolicy,
): RetryDecision {
  const policy = resolveRetryPolicy(node, fallback);

  if (errorClass === "cancelled") {
    return { retry: false, delaySeconds: 0, reason: "Run was cancelled" };
  }
  if (attempt >= policy.maxAttempts) {
    return {
      retry: false,
      delaySeconds: 0,
      reason: `Exhausted retry budget after ${attempt} attempt(s)`,
    };
  }
  if (!isRetryableError(policy, errorClass)) {
    return { retry: false, delaySeconds: 0, reason: `Error class "${errorClass}" is not retryable` };
  }

  const definition = getNodeType(node.type);
  if (definition?.destructive && node.config?.["idempotent"] !== true) {
    return {
      retry: false,
      delaySeconds: 0,
      reason: `"${node.type}" performs a destructive write and is not marked idempotent; refusing to retry`,
    };
  }

  return {
    retry: true,
    delaySeconds: computeDelay(policy, attempt, policy.maxDelaySeconds ?? 3600),
    reason: `Retrying after ${errorClass} error (attempt ${attempt + 1} of ${policy.maxAttempts})`,
  };
}

/** Maps an arbitrary thrown value onto an error class the retry planner understands. */
export function classifyError(error: unknown): ErrorClass {
  if (typeof error === "object" && error !== null && "errorClass" in error) {
    const cls = (error as { errorClass?: unknown }).errorClass;
    if (typeof cls === "string") return cls as ErrorClass;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = (error as { code?: string } | null)?.code ?? "";

  if (/abort|timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message + code)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|socket hang up/i.test(message + code)) return "connection";
  if (/rate ?limit|too many requests|\b429\b/i.test(message)) return "rate_limit";
  if (/\b(50[0234])\b|temporarily unavailable|deadlock|serialization failure|could not serialize/i.test(message)) return "transient";
  if (/permission|forbidden|unauthori[sz]ed|\b40[13]\b/i.test(message)) return "permission";
  if (/not found|\b404\b|does not exist|undefined column|unknown column/i.test(message)) return "not_found";
  if (/invalid|malformed|syntax error|must be|required/i.test(message)) return "validation";
  if (/quality (check|gate)/i.test(message)) return "data_quality";
  return "unknown";
}
