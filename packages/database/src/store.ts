import type { RunState, TaskState, WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import type {
  ApiKeyRecord, AuditLogEntry, Backfill, Connection, Dataset, Incident, IncidentKind,
  LineageEdgeRecord, Organization, OrganizationMember, Pipeline, PipelineVersion,
  QualityResultRecord, Role, RunEvent, Schedule, TaskAttempt, TaskLogEntry, TaskRun,
  UploadedFile, WorkflowRun,
} from "./types.js";
import type { DataSchema } from "@dataflow-studio/schema-registry";

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, absent on the last page. */
  nextCursor?: string;
  /** Total matching rows, when the driver can count cheaply. */
  total?: number;
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
}

export interface RunFilter extends PageRequest {
  pipelineId?: string;
  state?: RunState | RunState[];
  trigger?: string;
  backfillId?: string;
  scheduleId?: string;
  since?: string;
  until?: string;
  sort?: "queued_at" | "duration";
  direction?: "asc" | "desc";
}

export interface PipelineFilter extends PageRequest {
  search?: string;
  tag?: string;
  includeArchived?: boolean;
}

export interface LogFilter extends PageRequest {
  taskRunId?: string;
  attempt?: number;
  level?: TaskLogEntry["level"];
  search?: string;
  since?: string;
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  now?: Date;
  /** Restrict to specific node types, for heterogeneous worker pools. */
  nodeTypes?: string[];
}

export interface AnalyticsWindow {
  from: string;
  to: string;
  pipelineId?: string;
}

export interface RunAnalytics {
  totals: { runs: number; succeeded: number; failed: number; cancelled: number; running: number };
  successRate: number;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  /** One bucket per day in the window, ascending. */
  series: Array<{ date: string; succeeded: number; failed: number; cancelled: number; averageDurationMs: number | null }>;
  taskFailures: Array<{ nodeId: string; nodeType: string; failures: number }>;
  qualityFailures: number;
}

/**
 * The persistence contract.
 *
 * Every method is organization-scoped: tenant isolation is enforced here rather
 * than in route handlers, so a forgotten `WHERE organization_id = $1` cannot leak
 * data. Two drivers implement it - an in-memory driver used for development,
 * tests and single-process deployments, and a PostgreSQL driver for production.
 */
export interface Store {
  readonly driver: "memory" | "postgres";

  // ---------------------------------------------------------- organizations
  createOrganization(input: Omit<Organization, "createdAt"> & { createdAt?: string }): Promise<Organization>;
  getOrganization(id: string): Promise<Organization | null>;
  getOrganizationBySlug(slug: string): Promise<Organization | null>;
  listOrganizationsForUser(userId: string): Promise<Array<Organization & { role: Role }>>;
  upsertMember(member: OrganizationMember): Promise<OrganizationMember>;
  getMember(organizationId: string, userId: string): Promise<OrganizationMember | null>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  removeMember(organizationId: string, userId: string): Promise<boolean>;

  // --------------------------------------------------------------- pipelines
  createPipeline(pipeline: Pipeline): Promise<Pipeline>;
  getPipeline(organizationId: string, pipelineId: string): Promise<Pipeline | null>;
  getPipelineByName(organizationId: string, name: string): Promise<Pipeline | null>;
  listPipelines(organizationId: string, filter?: PipelineFilter): Promise<Page<Pipeline>>;
  updatePipeline(organizationId: string, pipelineId: string, patch: Partial<Pipeline>): Promise<Pipeline>;
  deletePipeline(organizationId: string, pipelineId: string): Promise<boolean>;

  createVersion(version: PipelineVersion): Promise<PipelineVersion>;
  getVersion(organizationId: string, versionId: string): Promise<PipelineVersion | null>;
  getVersionByNumber(organizationId: string, pipelineId: string, version: number): Promise<PipelineVersion | null>;
  listVersions(organizationId: string, pipelineId: string): Promise<PipelineVersion[]>;
  updateVersion(organizationId: string, versionId: string, patch: Partial<PipelineVersion>): Promise<PipelineVersion>;
  /** Marks one version published and deprecates the previous one, atomically. */
  publishVersion(organizationId: string, pipelineId: string, versionId: string, at: string): Promise<PipelineVersion>;

  // -------------------------------------------------------------------- runs
  createRun(run: WorkflowRun, tasks: TaskRun[]): Promise<WorkflowRun>;
  getRun(organizationId: string, runId: string): Promise<WorkflowRun | null>;
  listRuns(organizationId: string, filter?: RunFilter): Promise<Page<WorkflowRun>>;
  updateRun(organizationId: string, runId: string, patch: Partial<WorkflowRun>): Promise<WorkflowRun>;
  /** Most recent run per pipeline, for the pipeline list. */
  latestRunPerPipeline(organizationId: string, pipelineIds: string[]): Promise<Record<string, WorkflowRun>>;
  countRunsByState(organizationId: string): Promise<Record<RunState, number>>;

  listTasks(organizationId: string, runId: string): Promise<TaskRun[]>;
  getTask(organizationId: string, taskRunId: string): Promise<TaskRun | null>;
  updateTask(organizationId: string, taskRunId: string, patch: Partial<TaskRun>): Promise<TaskRun>;
  /** Atomically transitions a task, returning null when the expected state no longer holds. */
  compareAndSetTaskState(
    organizationId: string,
    taskRunId: string,
    expected: TaskState | TaskState[],
    patch: Partial<TaskRun> & { state: TaskState },
  ): Promise<TaskRun | null>;

  /** Claims one ready task for a worker, or null when the queue is empty. */
  claimNextTask(options: ClaimOptions): Promise<TaskRun | null>;
  /** Returns expired-lease tasks to QUEUED so another worker can pick them up. */
  reclaimExpiredLeases(now?: Date): Promise<TaskRun[]>;
  extendLease(organizationId: string, taskRunId: string, workerId: string, leaseSeconds: number): Promise<boolean>;

  appendAttempt(attempt: TaskAttempt): Promise<TaskAttempt>;
  listAttempts(organizationId: string, taskRunId: string): Promise<TaskAttempt[]>;

  appendLogs(entries: TaskLogEntry[]): Promise<void>;
  listLogs(organizationId: string, runId: string, filter?: LogFilter): Promise<Page<TaskLogEntry>>;

  appendRunEvent(event: Omit<RunEvent, "id" | "sequence" | "createdAt"> & { createdAt?: string }): Promise<RunEvent>;
  listRunEvents(organizationId: string, runId: string, afterSequence?: number): Promise<RunEvent[]>;

  // --------------------------------------------------------------- schedules
  createSchedule(schedule: Schedule): Promise<Schedule>;
  getSchedule(organizationId: string, scheduleId: string): Promise<Schedule | null>;
  listSchedules(organizationId: string, pipelineId?: string): Promise<Schedule[]>;
  updateSchedule(organizationId: string, scheduleId: string, patch: Partial<Schedule>): Promise<Schedule>;
  deleteSchedule(organizationId: string, scheduleId: string): Promise<boolean>;
  /** Due schedules across all organizations, claimed for dispatch. */
  claimDueSchedules(now: Date, limit?: number): Promise<Schedule[]>;

  createBackfill(backfill: Backfill): Promise<Backfill>;
  getBackfill(organizationId: string, backfillId: string): Promise<Backfill | null>;
  listBackfills(organizationId: string, pipelineId?: string): Promise<Backfill[]>;
  updateBackfill(organizationId: string, backfillId: string, patch: Partial<Backfill>): Promise<Backfill>;
  listActiveBackfills(limit?: number): Promise<Backfill[]>;

  // -------------------------------------------------------------- connectors
  createConnection(connection: Connection): Promise<Connection>;
  getConnection(organizationId: string, connectionId: string): Promise<Connection | null>;
  listConnections(organizationId: string): Promise<Connection[]>;
  updateConnection(organizationId: string, connectionId: string, patch: Partial<Connection>): Promise<Connection>;
  deleteConnection(organizationId: string, connectionId: string): Promise<boolean>;

  // ----------------------------------------------------------------- secrets
  getSecret(organizationId: string, name: string): Promise<import("@dataflow-studio/secrets").SecretRecord | null>;
  listSecrets(organizationId: string): Promise<import("@dataflow-studio/secrets").SecretRecord[]>;
  upsertSecret(record: import("@dataflow-studio/secrets").SecretRecord): Promise<import("@dataflow-studio/secrets").SecretRecord>;
  deleteSecret(organizationId: string, name: string): Promise<boolean>;
  touchSecret(organizationId: string, name: string, at: string): Promise<void>;

  // ---------------------------------------------------------------- datasets
  upsertDataset(dataset: Dataset): Promise<Dataset>;
  getDataset(organizationId: string, name: string): Promise<Dataset | null>;
  listDatasets(organizationId: string, filter?: PageRequest & { search?: string }): Promise<Page<Dataset>>;
  putDataset(
    organizationId: string,
    dataset: string,
    payload: { rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number; writeMode: "append" | "replace"; runId?: string },
  ): Promise<{ rowCount: number }>;
  getDatasetRows(organizationId: string, dataset: string): Promise<{ rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number } | null>;

  latestSchema(organizationId: string, dataset: string): Promise<DataSchema | null>;
  listSchemaVersions(organizationId: string, dataset: string): Promise<DataSchema[]>;
  insertSchema(organizationId: string, schema: DataSchema): Promise<DataSchema>;

  // ----------------------------------------------------------------- quality
  insertQualityResults(results: QualityResultRecord[]): Promise<void>;
  listQualityResults(
    organizationId: string,
    filter: { runId?: string; dataset?: string; pipelineId?: string; since?: string; limit?: number },
  ): Promise<QualityResultRecord[]>;

  // ----------------------------------------------------------------- lineage
  replaceLineage(organizationId: string, pipelineVersionId: string, edges: LineageEdgeRecord[]): Promise<void>;
  listLineage(organizationId: string, filter?: { pipelineId?: string; dataset?: string }): Promise<LineageEdgeRecord[]>;

  // --------------------------------------------------------------- incidents
  upsertIncident(incident: Incident): Promise<Incident>;
  getIncidentByFingerprint(organizationId: string, fingerprint: string): Promise<Incident | null>;
  listIncidents(organizationId: string, filter?: PageRequest & { status?: Incident["status"]; kind?: IncidentKind }): Promise<Page<Incident>>;
  updateIncident(organizationId: string, incidentId: string, patch: Partial<Incident>): Promise<Incident>;

  // ------------------------------------------------------------------- audit
  appendAudit(entry: AuditLogEntry): Promise<AuditLogEntry>;
  listAudit(organizationId: string, filter?: PageRequest & { action?: string; resourceType?: string; actor?: string }): Promise<Page<AuditLogEntry>>;

  // ---------------------------------------------------------------- api keys
  createApiKey(record: ApiKeyRecord): Promise<ApiKeyRecord>;
  getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | null>;
  listApiKeys(organizationId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(organizationId: string, keyId: string, at: string): Promise<boolean>;
  touchApiKey(keyId: string, at: string): Promise<void>;

  // -------------------------------------------------------- task data plane
  /**
   * Stores a task's output batch so a downstream task - possibly on another
   * worker - can read it. Bounded by `maxBatchBytes`; larger results must be
   * written to a real destination rather than passed through the control plane.
   */
  putTaskData(organizationId: string, runId: string, nodeId: string, batch: unknown): Promise<void>;
  getTaskData(organizationId: string, runId: string, nodeId: string): Promise<unknown | null>;
  deleteRunData(organizationId: string, runId: string): Promise<void>;

  // ------------------------------------------------------------------- files
  putFile(file: UploadedFile, content: Buffer): Promise<UploadedFile>;
  getFile(organizationId: string, fileId: string): Promise<{ file: UploadedFile; content: Buffer } | null>;
  listFiles(organizationId: string): Promise<UploadedFile[]>;

  // --------------------------------------------------------------- analytics
  runAnalytics(organizationId: string, window: AnalyticsWindow): Promise<RunAnalytics>;
  search(organizationId: string, query: string, limit?: number): Promise<SearchHit[]>;

  // -------------------------------------------------------------- lifecycle
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}

export interface SearchHit {
  type: "pipeline" | "run" | "dataset" | "incident" | "connection" | "task";
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
}

export interface StoreCapabilities {
  /** True when several processes can share this store. */
  multiProcess: boolean;
  /** True when the store survives a restart. */
  durable: boolean;
}

export function capabilitiesOf(store: Store): StoreCapabilities {
  return store.driver === "postgres"
    ? { multiProcess: true, durable: true }
    : { multiProcess: false, durable: false };
}

export interface WorkflowDefinitionRef {
  definition: WorkflowDefinition;
  versionId: string;
}
