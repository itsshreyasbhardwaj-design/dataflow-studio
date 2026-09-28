import type {
  PipelineVersionStatus, RunState, TaskState, TriggerType, WorkflowDefinition,
} from "@dataflow-studio/workflow-engine";

export interface Pipeline {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  publishedVersionId: string | null;
  latestVersionNumber: number;
  tags?: string[];
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface PipelineSummary extends Pipeline {
  latestRun?: Run;
  scheduleCount: number;
  publishedVersion?: number;
}

export interface PipelineVersion {
  id: string;
  pipelineId: string;
  version: number;
  status: PipelineVersionStatus;
  definition: WorkflowDefinition;
  definitionHash: string;
  createdAt: string;
  publishedAt?: string | null;
  changeSummary?: string[];
}

export interface Run {
  id: string;
  pipelineId: string;
  pipelineName: string;
  pipelineVersionId: string;
  version: number;
  state: RunState;
  trigger: TriggerType;
  triggeredBy: string;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  logicalDate?: string;
  totals?: { tasks: number; succeeded: number; failed: number; skipped: number; blocked: number };
}

export interface Task {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  state: TaskState;
  attempt: number;
  maxAttempts: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  errorClass?: string | null;
  output?: Record<string, unknown> | null;
  dependsOn: string[];
}

export interface LogEntry {
  id: string;
  runId: string;
  taskRunId: string;
  attempt: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  field?: string;
  hint?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface QualityResult {
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
  message: string;
}

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  rowCount?: number | null;
  latestSchemaVersion?: number;
  lastUpdatedAt?: string | null;
  qualityStatus?: "passing" | "failing" | "unknown";
}

export interface Incident {
  id: string;
  kind: string;
  severity: "low" | "medium" | "high";
  title: string;
  status: "open" | "acknowledged" | "resolved";
  evidence: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface Schedule {
  id: string;
  pipelineId: string;
  kind: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
  timezone: string;
  enabled: boolean;
  catchup: boolean;
  nextRunAt: string;
  description: string;
  upcoming: string[];
}

export interface Backfill {
  id: string;
  pipelineId: string;
  from: string;
  to: string;
  state: "pending" | "running" | "paused" | "completed" | "cancelled" | "failed";
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
}

export interface RunEventMessage {
  id?: number;
  type: string;
  data: Record<string, unknown>;
}

export type { WorkflowDefinition };
