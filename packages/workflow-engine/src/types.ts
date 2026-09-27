/**
 * The portable workflow definition. This is the contract between the visual
 * editor, the CLI, the API and the execution engine: anything that can produce
 * this JSON can drive a pipeline, and the editor is only one such producer.
 */

export const NODE_KINDS = [
  "source",
  "transform",
  "filter",
  "join",
  "aggregate",
  "validate",
  "quality_gate",
  "destination",
  "python",
  "sql",
  "http",
  "webhook",
  "delay",
  "condition",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Fully-qualified node type, e.g. `postgres.source`, `sql.transform`.
 * The registry (see node-types.ts) maps these to a kind, a config schema and
 * the executor that runs them.
 */
export type NodeType = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A pointer to a secret. The value is resolved by the worker, never by the UI. */
export interface SecretReference {
  secretRef: string;
}

export function isSecretReference(value: unknown): value is SecretReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { secretRef?: unknown }).secretRef === "string"
  );
}

export type ConfigValue = JsonValue | SecretReference;
export type NodeConfig = Record<string, ConfigValue>;

export const RETRYABLE_ERROR_CLASSES = [
  "timeout",
  "connection",
  "rate_limit",
  "transient",
  "internal",
] as const;
export type ErrorClass =
  | (typeof RETRYABLE_ERROR_CLASSES)[number]
  | "configuration"
  | "validation"
  | "permission"
  | "not_found"
  | "data_quality"
  | "cancelled"
  | "unknown";

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retries. */
  maxAttempts: number;
  /** Backoff strategy. `explicit` uses `delaysSeconds` verbatim. */
  strategy: "exponential" | "fixed" | "explicit";
  /** First delay for exponential/fixed, in seconds. */
  initialDelaySeconds?: number;
  /** Multiplier for exponential backoff. */
  multiplier?: number;
  /** Clamp on any computed delay, in seconds. */
  maxDelaySeconds?: number;
  /** Explicit per-attempt delays, in seconds. */
  delaysSeconds?: number[];
  /** Error classes that may be retried. Defaults to RETRYABLE_ERROR_CLASSES. */
  retryableErrors?: ErrorClass[];
  /** Error classes that must never be retried, even if listed above. */
  nonRetryableErrors?: ErrorClass[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  strategy: "exponential",
  initialDelaySeconds: 5,
  multiplier: 6,
  maxDelaySeconds: 900,
};

/** A node that writes data is not retried blindly - see isDestructive(). */
export const NO_RETRY_POLICY: RetryPolicy = { maxAttempts: 1, strategy: "fixed" };

export interface NodeMetadata {
  label?: string;
  description?: string;
  owner?: string;
  tags?: string[];
  /** Editor canvas position. Purely presentational. */
  position?: { x: number; y: number };
  [key: string]: JsonValue | undefined;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  config: NodeConfig;
  retry?: RetryPolicy;
  /** Hard wall-clock limit for a single attempt, in seconds. */
  timeoutSeconds?: number;
  /**
   * When true, a failure of this node does not fail the run; downstream nodes
   * are marked SKIPPED and the run can still succeed.
   */
  continueOnFailure?: boolean;
  metadata?: NodeMetadata;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /**
   * Output port of the source node. `condition` nodes emit `true` / `false`;
   * everything else emits `default`.
   */
  port?: string;
}

export interface WorkflowDefinition {
  name: string;
  /** Monotonic version number assigned by the API on publish. */
  version: number;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Free-form parameters available to nodes as `{{ params.x }}`. */
  params?: JsonObject;
  /** Default retry policy for nodes that do not declare one. */
  defaults?: { retry?: RetryPolicy; timeoutSeconds?: number };
  metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// Execution states
// ---------------------------------------------------------------------------

export const TASK_STATES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
  "RETRYING",
  "BLOCKED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const RUN_STATES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
  "BLOCKED",
];
export const TERMINAL_RUN_STATES: readonly RunState[] = ["SUCCESS", "FAILED", "CANCELLED"];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}
export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export type TriggerType = "manual" | "schedule" | "backfill" | "api" | "webhook" | "retry";

export const PIPELINE_VERSION_STATUSES = ["draft", "published", "deprecated"] as const;
export type PipelineVersionStatus = (typeof PIPELINE_VERSION_STATUSES)[number];
