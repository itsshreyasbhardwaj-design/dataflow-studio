import type {
  JsonObject, PipelineVersionStatus, RunState, TaskState, TriggerType, WorkflowDefinition,
} from "@dataflow-studio/workflow-engine";

export type Role = "owner" | "admin" | "developer" | "viewer";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  /** Demo organizations are seeded with clearly-labelled example data. */
  isDemo?: boolean;
}

export interface OrganizationMember {
  organizationId: string;
  userId: string;
  role: Role;
  email?: string;
  name?: string;
  createdAt: string;
}

export interface Pipeline {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  /** Version currently used by schedules and API runs. Null until first publish. */
  publishedVersionId: string | null;
  latestVersionNumber: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  tags?: string[];
  isDemo?: boolean;
}

export interface PipelineVersion {
  id: string;
  organizationId: string;
  pipelineId: string;
  version: number;
  status: PipelineVersionStatus;
  definition: WorkflowDefinition;
  /** Hash of the executable definition; equal hashes mean equal behaviour. */
  definitionHash: string;
  createdBy: string;
  createdAt: string;
  publishedAt?: string | null;
  deprecatedAt?: string | null;
  changeSummary?: string[];
}

export interface WorkflowRun {
  id: string;
  organizationId: string;
  pipelineId: string;
  pipelineVersionId: string;
  pipelineName: string;
  version: number;
  state: RunState;
  trigger: TriggerType;
  triggeredBy: string;
  /** Parameters merged over the definition's defaults for this run. */
  params?: JsonObject;
  /** Logical date this run represents; differs from startedAt for backfills. */
  logicalDate?: string;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  cancellationRequestedAt?: string | null;
  cancellationRequestedBy?: string | null;
  backfillId?: string | null;
  scheduleId?: string | null;
  /** Run this one retries, when it was created by a retry. */
  retryOfRunId?: string | null;
  requestId?: string;
  isDemo?: boolean;
  totals?: { tasks: number; succeeded: number; failed: number; skipped: number; blocked: number };
}

export interface TaskRun {
  id: string;
  organizationId: string;
  runId: string;
  pipelineId: string;
  nodeId: string;
  nodeType: string;
  state: TaskState;
  attempt: number;
  maxAttempts: number;
  /** Earliest time a worker may claim this task; set by retry backoff and delays. */
  scheduledAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  workerId?: string | null;
  /** Lease expiry. A task whose lease lapses is reclaimed after a worker crash. */
  leaseExpiresAt?: string | null;
  error?: string | null;
  errorClass?: string | null;
  /** Row counts and connector details, never raw data. */
  output?: JsonObject | null;
  /** Names of upstream nodes, denormalized so the run page needs one query. */
  dependsOn: string[];
  priority: number;
}

export interface TaskAttempt {
  id: string;
  organizationId: string;
  taskRunId: string;
  runId: string;
  attempt: number;
  state: TaskState;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  workerId?: string | null;
  error?: string | null;
  errorClass?: string | null;
  output?: JsonObject | null;
}

export interface TaskLogEntry {
  id: string;
  organizationId: string;
  runId: string;
  taskRunId: string;
  attempt: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: JsonObject;
}

export interface Schedule {
  id: string;
  organizationId: string;
  pipelineId: string;
  /** Pinned version, or null to always use the published version. */
  pipelineVersionId?: string | null;
  kind: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
  timezone: string;
  enabled: boolean;
  /** Skip a fire if the previous run of this schedule is still running. */
  catchup: boolean;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Backfill {
  id: string;
  organizationId: string;
  pipelineId: string;
  pipelineVersionId: string;
  from: string;
  to: string;
  intervalSeconds: number;
  concurrency: number;
  state: "pending" | "running" | "paused" | "completed" | "cancelled" | "failed";
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  /** Logical dates not yet dispatched. */
  pendingDates: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export interface Connection {
  id: string;
  organizationId: string;
  name: string;
  family: string;
  /** Non-secret settings. Credentials live in `secretRefs`. */
  config: JsonObject;
  /** Maps a config key to a secret name, e.g. `{ password: "prod-pg-password" }`. */
  secretRefs: Record<string, string>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string | null;
}

export interface Dataset {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  owner?: string;
  /** Node type that produced it, e.g. `postgres.destination`. */
  sourceType?: string;
  latestSchemaVersion?: number;
  rowCount?: number | null;
  /** Retained preview rows, capped by the destination node's config. */
  previewRows?: JsonObject[];
  previewColumns?: JsonObject[];
  lastUpdatedAt?: string | null;
  lastRunId?: string | null;
  qualityStatus?: "passing" | "failing" | "unknown";
  createdAt: string;
  isDemo?: boolean;
}

export interface QualityResultRecord {
  id: string;
  organizationId: string;
  runId: string;
  taskRunId: string;
  pipelineId: string;
  dataset?: string;
  checkId: string;
  checkType: string;
  column?: string;
  status: "PASSED" | "FAILED" | "ERRORED";
  severity: "error" | "warn";
  expected: string;
  actual: string;
  passedRows: number;
  failedRows: number;
  totalRows: number;
  passRate: number;
  failedSamples?: JsonObject;
  message: string;
  createdAt: string;
}

export interface LineageEdgeRecord {
  id: string;
  organizationId: string;
  pipelineId: string;
  pipelineVersionId: string;
  fromType: "dataset" | "node";
  fromId: string;
  toType: "dataset" | "node";
  toId: string;
  nodeId?: string;
  transformation?: string;
  observedAt: string;
}

export type IncidentKind =
  | "repeated_failure"
  | "duration_spike"
  | "quality_failure"
  | "schema_change"
  | "missing_data"
  | "stale_dataset";

export interface Incident {
  id: string;
  organizationId: string;
  kind: IncidentKind;
  severity: "low" | "medium" | "high";
  title: string;
  /** Evidence gathered when the incident was opened. Never speculation. */
  evidence: JsonObject;
  pipelineId?: string | null;
  runId?: string | null;
  dataset?: string | null;
  status: "open" | "acknowledged" | "resolved";
  /** Stable key so a repeating condition updates one incident instead of spamming. */
  fingerprint: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
}

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  actor: string;
  actorType: "user" | "api_key" | "system" | "schedule";
  action: string;
  resourceType: string;
  resourceId?: string;
  result: "success" | "denied" | "error";
  requestId?: string;
  ip?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  name: string;
  /** SHA-256 of the token. The plaintext is shown once at creation and never stored. */
  tokenHash: string;
  prefix: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface RunEvent {
  id: number;
  organizationId: string;
  runId: string;
  /** Monotonic per-run sequence, so a reconnecting stream can resume. */
  sequence: number;
  type:
    | "run.queued" | "run.started" | "run.finished" | "run.cancelling"
    | "task.queued" | "task.started" | "task.finished" | "task.retrying" | "task.blocked" | "task.skipped"
    | "log" | "quality";
  payload: JsonObject;
  createdAt: string;
}

export interface UploadedFile {
  id: string;
  organizationId: string;
  filename: string;
  contentType?: string;
  bytes: number;
  createdBy: string;
  createdAt: string;
}
