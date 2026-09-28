import { newId } from "@dataflow-studio/observability";
import type { DataSchema } from "@dataflow-studio/schema-registry";
import type { SecretRecord } from "@dataflow-studio/secrets";
import type { RunState, TaskState } from "@dataflow-studio/workflow-engine";
import { clampLimit, paginate } from "./cursor.js";
import type {
  AnalyticsWindow, ClaimOptions, LogFilter, Page, PageRequest, PipelineFilter,
  RunAnalytics, RunFilter, SearchHit, Store,
} from "./store.js";
import type {
  ApiKeyRecord, AuditLogEntry, Backfill, Connection, Dataset, Incident, IncidentKind,
  LineageEdgeRecord, Organization, OrganizationMember, Pipeline, PipelineVersion,
  QualityResultRecord, Role, RunEvent, Schedule, TaskAttempt, TaskLogEntry, TaskRun,
  UploadedFile, WorkflowRun,
} from "./types.js";

export class NotFoundError extends Error {
  readonly errorClass = "not_found";
  constructor(what: string, id: string) {
    super(`${what} "${id}" was not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly errorClass = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

/**
 * In-memory driver.
 *
 * This is the default for local development, the test suite and single-process
 * self-hosting. It implements the full Store contract - including lease-based
 * task claiming - so the execution engine runs identically here and against
 * PostgreSQL. It is explicitly not durable and not shared between processes;
 * `capabilitiesOf()` reports that, and the worker refuses to run detached from
 * the API when it would matter.
 */
export class MemoryStore implements Store {
  readonly driver = "memory" as const;

  private readonly organizations = new Map<string, Organization>();
  private readonly members = new Map<string, OrganizationMember>();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly versions = new Map<string, PipelineVersion>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly tasks = new Map<string, TaskRun>();
  private readonly attempts: TaskAttempt[] = [];
  private readonly logs: TaskLogEntry[] = [];
  private readonly events: RunEvent[] = [];
  private readonly schedules = new Map<string, Schedule>();
  private readonly backfills = new Map<string, Backfill>();
  private readonly connections = new Map<string, Connection>();
  private readonly secrets = new Map<string, SecretRecord>();
  private readonly datasets = new Map<string, Dataset>();
  private readonly datasetRows = new Map<string, { rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number }>();
  private readonly schemas: Array<DataSchema & { organizationId: string }> = [];
  private readonly qualityResults: QualityResultRecord[] = [];
  private readonly lineage: LineageEdgeRecord[] = [];
  private readonly incidents = new Map<string, Incident>();
  private readonly audit: AuditLogEntry[] = [];
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly files = new Map<string, { file: UploadedFile; content: Buffer }>();
  private readonly taskData = new Map<string, unknown>();
  private eventSequence = 0;
  private eventId = 0;

  /** Notifies subscribers (the SSE endpoint) that a run produced an event. */
  private readonly listeners = new Set<(event: RunEvent) => void>();

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private key(organizationId: string, id: string): string {
    return `${organizationId}/${id}`;
  }

  // ------------------------------------------------------------ organizations
  async createOrganization(input: Organization): Promise<Organization> {
    if ([...this.organizations.values()].some((o) => o.slug === input.slug)) {
      throw new ConflictError(`An organization with slug "${input.slug}" already exists`);
    }
    const organization: Organization = { ...input, createdAt: input.createdAt ?? new Date().toISOString() };
    this.organizations.set(organization.id, organization);
    return clone(organization);
  }

  async getOrganization(id: string): Promise<Organization | null> {
    return clone(this.organizations.get(id) ?? null);
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    return clone([...this.organizations.values()].find((o) => o.slug === slug) ?? null);
  }

  async listOrganizationsForUser(userId: string): Promise<Array<Organization & { role: Role }>> {
    return [...this.members.values()]
      .filter((m) => m.userId === userId)
      .map((m) => {
        const organization = this.organizations.get(m.organizationId);
        return organization ? { ...clone(organization), role: m.role } : null;
      })
      .filter((o): o is Organization & { role: Role } => o !== null);
  }

  async upsertMember(member: OrganizationMember): Promise<OrganizationMember> {
    this.members.set(this.key(member.organizationId, member.userId), clone(member));
    return clone(member);
  }

  async getMember(organizationId: string, userId: string): Promise<OrganizationMember | null> {
    return clone(this.members.get(this.key(organizationId, userId)) ?? null);
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return [...this.members.values()].filter((m) => m.organizationId === organizationId).map(clone);
  }

  async removeMember(organizationId: string, userId: string): Promise<boolean> {
    return this.members.delete(this.key(organizationId, userId));
  }

  // ----------------------------------------------------------------- pipelines
  async createPipeline(pipeline: Pipeline): Promise<Pipeline> {
    const existing = await this.getPipelineByName(pipeline.organizationId, pipeline.name);
    if (existing) throw new ConflictError(`A pipeline named "${pipeline.name}" already exists`);
    this.pipelines.set(this.key(pipeline.organizationId, pipeline.id), clone(pipeline));
    return clone(pipeline);
  }

  async getPipeline(organizationId: string, pipelineId: string): Promise<Pipeline | null> {
    return clone(this.pipelines.get(this.key(organizationId, pipelineId)) ?? null);
  }

  async getPipelineByName(organizationId: string, name: string): Promise<Pipeline | null> {
    return clone(
      [...this.pipelines.values()].find((p) => p.organizationId === organizationId && p.name === name && !p.archivedAt) ?? null,
    );
  }

  async listPipelines(organizationId: string, filter: PipelineFilter = {}): Promise<Page<Pipeline>> {
    const search = filter.search?.toLowerCase();
    const items = [...this.pipelines.values()]
      .filter((p) => p.organizationId === organizationId)
      .filter((p) => (filter.includeArchived ? true : !p.archivedAt))
      .filter((p) => (filter.tag ? p.tags?.includes(filter.tag) : true))
      .filter((p) => (search ? p.name.toLowerCase().includes(search) || (p.description ?? "").toLowerCase().includes(search) : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return paginate(items.map(clone), { ...filter, value: (p) => p.updatedAt, id: (p) => p.id });
  }

  async updatePipeline(organizationId: string, pipelineId: string, patch: Partial<Pipeline>): Promise<Pipeline> {
    const key = this.key(organizationId, pipelineId);
    const existing = this.pipelines.get(key);
    if (!existing) throw new NotFoundError("Pipeline", pipelineId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.pipelines.set(key, updated);
    return clone(updated);
  }

  async deletePipeline(organizationId: string, pipelineId: string): Promise<boolean> {
    for (const [key, version] of this.versions) {
      if (version.organizationId === organizationId && version.pipelineId === pipelineId) this.versions.delete(key);
    }
    return this.pipelines.delete(this.key(organizationId, pipelineId));
  }

  async createVersion(version: PipelineVersion): Promise<PipelineVersion> {
    this.versions.set(this.key(version.organizationId, version.id), clone(version));
    return clone(version);
  }

  async getVersion(organizationId: string, versionId: string): Promise<PipelineVersion | null> {
    return clone(this.versions.get(this.key(organizationId, versionId)) ?? null);
  }

  async getVersionByNumber(organizationId: string, pipelineId: string, version: number): Promise<PipelineVersion | null> {
    return clone(
      [...this.versions.values()].find(
        (v) => v.organizationId === organizationId && v.pipelineId === pipelineId && v.version === version,
      ) ?? null,
    );
  }

  async listVersions(organizationId: string, pipelineId: string): Promise<PipelineVersion[]> {
    return [...this.versions.values()]
      .filter((v) => v.organizationId === organizationId && v.pipelineId === pipelineId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async updateVersion(organizationId: string, versionId: string, patch: Partial<PipelineVersion>): Promise<PipelineVersion> {
    const key = this.key(organizationId, versionId);
    const existing = this.versions.get(key);
    if (!existing) throw new NotFoundError("Pipeline version", versionId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.versions.set(key, updated);
    return clone(updated);
  }

  async publishVersion(organizationId: string, pipelineId: string, versionId: string, at: string): Promise<PipelineVersion> {
    const version = await this.getVersion(organizationId, versionId);
    if (!version || version.pipelineId !== pipelineId) throw new NotFoundError("Pipeline version", versionId);

    for (const candidate of [...this.versions.values()]) {
      if (
        candidate.organizationId === organizationId &&
        candidate.pipelineId === pipelineId &&
        candidate.status === "published" &&
        candidate.id !== versionId
      ) {
        this.versions.set(this.key(organizationId, candidate.id), { ...candidate, status: "deprecated", deprecatedAt: at });
      }
    }
    const published = await this.updateVersion(organizationId, versionId, { status: "published", publishedAt: at });
    await this.updatePipeline(organizationId, pipelineId, { publishedVersionId: versionId, updatedAt: at });
    return published;
  }

  // ---------------------------------------------------------------------- runs
  async createRun(run: WorkflowRun, tasks: TaskRun[]): Promise<WorkflowRun> {
    this.runs.set(this.key(run.organizationId, run.id), clone(run));
    for (const task of tasks) this.tasks.set(this.key(task.organizationId, task.id), clone(task));
    return clone(run);
  }

  async getRun(organizationId: string, runId: string): Promise<WorkflowRun | null> {
    return clone(this.runs.get(this.key(organizationId, runId)) ?? null);
  }

  async listRuns(organizationId: string, filter: RunFilter = {}): Promise<Page<WorkflowRun>> {
    const states = filter.state ? (Array.isArray(filter.state) ? filter.state : [filter.state]) : null;
    const items = [...this.runs.values()]
      .filter((r) => r.organizationId === organizationId)
      .filter((r) => (filter.pipelineId ? r.pipelineId === filter.pipelineId : true))
      .filter((r) => (states ? states.includes(r.state) : true))
      .filter((r) => (filter.trigger ? r.trigger === filter.trigger : true))
      .filter((r) => (filter.backfillId ? r.backfillId === filter.backfillId : true))
      .filter((r) => (filter.scheduleId ? r.scheduleId === filter.scheduleId : true))
      .filter((r) => (filter.since ? r.queuedAt >= filter.since : true))
      .filter((r) => (filter.until ? r.queuedAt <= filter.until : true))
      .sort((a, b) =>
        filter.sort === "duration"
          ? (b.durationMs ?? 0) - (a.durationMs ?? 0)
          : b.queuedAt.localeCompare(a.queuedAt) || b.id.localeCompare(a.id),
      );
    return paginate(items.map(clone), { ...filter, value: (r) => r.queuedAt, id: (r) => r.id });
  }

  async updateRun(organizationId: string, runId: string, patch: Partial<WorkflowRun>): Promise<WorkflowRun> {
    const key = this.key(organizationId, runId);
    const existing = this.runs.get(key);
    if (!existing) throw new NotFoundError("Run", runId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.runs.set(key, updated);
    return clone(updated);
  }

  async latestRunPerPipeline(organizationId: string, pipelineIds: string[]): Promise<Record<string, WorkflowRun>> {
    const wanted = new Set(pipelineIds);
    const out: Record<string, WorkflowRun> = {};
    for (const run of this.runs.values()) {
      if (run.organizationId !== organizationId || !wanted.has(run.pipelineId)) continue;
      const current = out[run.pipelineId];
      if (!current || run.queuedAt > current.queuedAt) out[run.pipelineId] = clone(run);
    }
    return out;
  }

  async countRunsByState(organizationId: string): Promise<Record<RunState, number>> {
    const counts = { PENDING: 0, QUEUED: 0, RUNNING: 0, SUCCESS: 0, FAILED: 0, CANCELLED: 0 } as Record<RunState, number>;
    for (const run of this.runs.values()) {
      if (run.organizationId === organizationId) counts[run.state]++;
    }
    return counts;
  }

  async listTasks(organizationId: string, runId: string): Promise<TaskRun[]> {
    return [...this.tasks.values()]
      .filter((t) => t.organizationId === organizationId && t.runId === runId)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(clone);
  }

  async getTask(organizationId: string, taskRunId: string): Promise<TaskRun | null> {
    return clone(this.tasks.get(this.key(organizationId, taskRunId)) ?? null);
  }

  async updateTask(organizationId: string, taskRunId: string, patch: Partial<TaskRun>): Promise<TaskRun> {
    const key = this.key(organizationId, taskRunId);
    const existing = this.tasks.get(key);
    if (!existing) throw new NotFoundError("Task", taskRunId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.tasks.set(key, updated);
    return clone(updated);
  }

  async compareAndSetTaskState(
    organizationId: string,
    taskRunId: string,
    expected: TaskState | TaskState[],
    patch: Partial<TaskRun> & { state: TaskState },
  ): Promise<TaskRun | null> {
    const key = this.key(organizationId, taskRunId);
    const existing = this.tasks.get(key);
    if (!existing) return null;
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(existing.state)) return null;
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.tasks.set(key, updated);
    return clone(updated);
  }

  async claimNextTask(options: ClaimOptions): Promise<TaskRun | null> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const candidates = [...this.tasks.values()]
      .filter((t) => t.state === "QUEUED" || t.state === "RETRYING")
      .filter((t) => t.scheduledAt <= nowIso)
      .filter((t) => (options.nodeTypes ? options.nodeTypes.includes(t.nodeType) : true))
      .sort((a, b) => b.priority - a.priority || a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));

    const task = candidates[0];
    if (!task) return null;
    return this.updateTask(task.organizationId, task.id, {
      state: "RUNNING",
      workerId: options.workerId,
      leaseExpiresAt: new Date(now.getTime() + options.leaseSeconds * 1000).toISOString(),
      startedAt: task.startedAt ?? nowIso,
    });
  }

  async reclaimExpiredLeases(now: Date = new Date()): Promise<TaskRun[]> {
    const nowIso = now.toISOString();
    const reclaimed: TaskRun[] = [];
    for (const task of [...this.tasks.values()]) {
      if (task.state !== "RUNNING" || !task.leaseExpiresAt || task.leaseExpiresAt > nowIso) continue;
      reclaimed.push(
        await this.updateTask(task.organizationId, task.id, {
          state: "QUEUED",
          workerId: null,
          leaseExpiresAt: null,
        }),
      );
    }
    return reclaimed;
  }

  async extendLease(organizationId: string, taskRunId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const task = this.tasks.get(this.key(organizationId, taskRunId));
    if (!task || task.workerId !== workerId || task.state !== "RUNNING") return false;
    await this.updateTask(organizationId, taskRunId, {
      leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
    });
    return true;
  }

  async appendAttempt(attempt: TaskAttempt): Promise<TaskAttempt> {
    // Upsert on (taskRunId, attempt) to match the PostgreSQL unique constraint:
    // one row per attempt, updated as the attempt progresses.
    const index = this.attempts.findIndex(
      (a) => a.taskRunId === attempt.taskRunId && a.attempt === attempt.attempt,
    );
    if (index >= 0) this.attempts[index] = { ...this.attempts[index]!, ...clone(attempt) };
    else this.attempts.push(clone(attempt));
    return clone(attempt);
  }

  async listAttempts(organizationId: string, taskRunId: string): Promise<TaskAttempt[]> {
    return this.attempts
      .filter((a) => a.organizationId === organizationId && a.taskRunId === taskRunId)
      .sort((a, b) => a.attempt - b.attempt)
      .map(clone);
  }

  async appendLogs(entries: TaskLogEntry[]): Promise<void> {
    for (const entry of entries) this.logs.push(clone(entry));
    // Bound memory in long-lived dev sessions.
    if (this.logs.length > 200_000) this.logs.splice(0, this.logs.length - 200_000);
  }

  async listLogs(organizationId: string, runId: string, filter: LogFilter = {}): Promise<Page<TaskLogEntry>> {
    const search = filter.search?.toLowerCase();
    const items = this.logs
      .filter((l) => l.organizationId === organizationId && l.runId === runId)
      .filter((l) => (filter.taskRunId ? l.taskRunId === filter.taskRunId : true))
      .filter((l) => (filter.attempt !== undefined ? l.attempt === filter.attempt : true))
      .filter((l) => (filter.level ? l.level === filter.level : true))
      .filter((l) => (filter.since ? l.timestamp >= filter.since : true))
      .filter((l) => (search ? l.message.toLowerCase().includes(search) : true))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    return paginate(items.map(clone), { ...filter, value: (l) => l.timestamp, id: (l) => l.id, direction: "asc" });
  }

  async appendRunEvent(event: Omit<RunEvent, "id" | "sequence" | "createdAt"> & { createdAt?: string }): Promise<RunEvent> {
    const sequence = ++this.eventSequence;
    const stored: RunEvent = {
      ...event,
      id: ++this.eventId,
      sequence,
      createdAt: event.createdAt ?? new Date().toISOString(),
    } as RunEvent;
    this.events.push(clone(stored));
    if (this.events.length > 100_000) this.events.splice(0, this.events.length - 100_000);
    for (const listener of this.listeners) {
      try { listener(clone(stored)); } catch { /* a broken subscriber must not break execution */ }
    }
    return clone(stored);
  }

  async listRunEvents(organizationId: string, runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return this.events
      .filter((e) => e.organizationId === organizationId && e.runId === runId && e.sequence > afterSequence)
      .map(clone);
  }

  // ----------------------------------------------------------------- schedules
  async createSchedule(schedule: Schedule): Promise<Schedule> {
    this.schedules.set(this.key(schedule.organizationId, schedule.id), clone(schedule));
    return clone(schedule);
  }

  async getSchedule(organizationId: string, scheduleId: string): Promise<Schedule | null> {
    return clone(this.schedules.get(this.key(organizationId, scheduleId)) ?? null);
  }

  async listSchedules(organizationId: string, pipelineId?: string): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter((s) => s.organizationId === organizationId)
      .filter((s) => (pipelineId ? s.pipelineId === pipelineId : true))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .map(clone);
  }

  async updateSchedule(organizationId: string, scheduleId: string, patch: Partial<Schedule>): Promise<Schedule> {
    const key = this.key(organizationId, scheduleId);
    const existing = this.schedules.get(key);
    if (!existing) throw new NotFoundError("Schedule", scheduleId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.schedules.set(key, updated);
    return clone(updated);
  }

  async deleteSchedule(organizationId: string, scheduleId: string): Promise<boolean> {
    return this.schedules.delete(this.key(organizationId, scheduleId));
  }

  async claimDueSchedules(now: Date, limit = 50): Promise<Schedule[]> {
    const nowIso = now.toISOString();
    return [...this.schedules.values()]
      .filter((s) => s.enabled && s.nextRunAt <= nowIso)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, clampLimit(limit))
      .map(clone);
  }

  async createBackfill(backfill: Backfill): Promise<Backfill> {
    this.backfills.set(this.key(backfill.organizationId, backfill.id), clone(backfill));
    return clone(backfill);
  }

  async getBackfill(organizationId: string, backfillId: string): Promise<Backfill | null> {
    return clone(this.backfills.get(this.key(organizationId, backfillId)) ?? null);
  }

  async listBackfills(organizationId: string, pipelineId?: string): Promise<Backfill[]> {
    return [...this.backfills.values()]
      .filter((b) => b.organizationId === organizationId)
      .filter((b) => (pipelineId ? b.pipelineId === pipelineId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async updateBackfill(organizationId: string, backfillId: string, patch: Partial<Backfill>): Promise<Backfill> {
    const key = this.key(organizationId, backfillId);
    const existing = this.backfills.get(key);
    if (!existing) throw new NotFoundError("Backfill", backfillId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.backfills.set(key, updated);
    return clone(updated);
  }

  async listActiveBackfills(limit = 20): Promise<Backfill[]> {
    return [...this.backfills.values()]
      .filter((b) => b.state === "running" || b.state === "pending")
      .slice(0, limit)
      .map(clone);
  }

  // ---------------------------------------------------------------- connectors
  async createConnection(connection: Connection): Promise<Connection> {
    if ([...this.connections.values()].some((c) => c.organizationId === connection.organizationId && c.name === connection.name)) {
      throw new ConflictError(`A connection named "${connection.name}" already exists`);
    }
    this.connections.set(this.key(connection.organizationId, connection.id), clone(connection));
    return clone(connection);
  }

  async getConnection(organizationId: string, connectionId: string): Promise<Connection | null> {
    return clone(this.connections.get(this.key(organizationId, connectionId)) ?? null);
  }

  async listConnections(organizationId: string): Promise<Connection[]> {
    return [...this.connections.values()].filter((c) => c.organizationId === organizationId).map(clone);
  }

  async updateConnection(organizationId: string, connectionId: string, patch: Partial<Connection>): Promise<Connection> {
    const key = this.key(organizationId, connectionId);
    const existing = this.connections.get(key);
    if (!existing) throw new NotFoundError("Connection", connectionId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.connections.set(key, updated);
    return clone(updated);
  }

  async deleteConnection(organizationId: string, connectionId: string): Promise<boolean> {
    return this.connections.delete(this.key(organizationId, connectionId));
  }

  // ------------------------------------------------------------------- secrets
  async getSecret(organizationId: string, name: string): Promise<SecretRecord | null> {
    return clone(this.secrets.get(this.key(organizationId, name)) ?? null);
  }

  async listSecrets(organizationId: string): Promise<SecretRecord[]> {
    return [...this.secrets.values()].filter((s) => s.organizationId === organizationId).map(clone);
  }

  async upsertSecret(record: SecretRecord): Promise<SecretRecord> {
    this.secrets.set(this.key(record.organizationId, record.name), clone(record));
    return clone(record);
  }

  async deleteSecret(organizationId: string, name: string): Promise<boolean> {
    return this.secrets.delete(this.key(organizationId, name));
  }

  async touchSecret(organizationId: string, name: string, at: string): Promise<void> {
    const existing = this.secrets.get(this.key(organizationId, name));
    if (existing) this.secrets.set(this.key(organizationId, name), { ...existing, lastUsedAt: at });
  }

  // ------------------------------------------------------------------ datasets
  async upsertDataset(dataset: Dataset): Promise<Dataset> {
    const key = this.key(dataset.organizationId, dataset.name);
    const existing = this.datasets.get(key);
    const merged = { ...existing, ...clone(dataset) };
    this.datasets.set(key, merged);
    return clone(merged);
  }

  async getDataset(organizationId: string, name: string): Promise<Dataset | null> {
    return clone(this.datasets.get(this.key(organizationId, name)) ?? null);
  }

  async listDatasets(organizationId: string, filter: PageRequest & { search?: string } = {}): Promise<Page<Dataset>> {
    const search = filter.search?.toLowerCase();
    const items = [...this.datasets.values()]
      .filter((d) => d.organizationId === organizationId)
      .filter((d) => (search ? d.name.toLowerCase().includes(search) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
    return paginate(items.map(clone), { ...filter, value: (d) => d.name, id: (d) => d.id, direction: "asc" });
  }

  async putDataset(
    organizationId: string,
    dataset: string,
    payload: { rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number; writeMode: "append" | "replace"; runId?: string },
  ): Promise<{ rowCount: number }> {
    const key = this.key(organizationId, dataset);
    const existing = this.datasetRows.get(key);
    const rows = payload.writeMode === "append" && existing ? [...existing.rows, ...payload.rows] : payload.rows;
    const rowCount = payload.writeMode === "append" && existing ? existing.rowCount + payload.rowCount : payload.rowCount;
    this.datasetRows.set(key, { rows: clone(rows), columns: clone(payload.columns), rowCount });

    const now = new Date().toISOString();
    await this.upsertDataset({
      id: this.datasets.get(key)?.id ?? newId("ds"),
      organizationId,
      name: dataset,
      rowCount,
      previewRows: clone(rows.slice(0, 100)) as never,
      previewColumns: clone(payload.columns) as never,
      lastUpdatedAt: now,
      ...(payload.runId ? { lastRunId: payload.runId } : {}),
      createdAt: this.datasets.get(key)?.createdAt ?? now,
    });
    return { rowCount };
  }

  async getDatasetRows(organizationId: string, dataset: string) {
    return clone(this.datasetRows.get(this.key(organizationId, dataset)) ?? null);
  }

  async latestSchema(organizationId: string, dataset: string): Promise<DataSchema | null> {
    return clone(
      this.schemas
        .filter((s) => s.organizationId === organizationId && s.dataset === dataset)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    );
  }

  async listSchemaVersions(organizationId: string, dataset: string): Promise<DataSchema[]> {
    return this.schemas
      .filter((s) => s.organizationId === organizationId && s.dataset === dataset)
      .sort((a, b) => a.version - b.version)
      .map(clone);
  }

  async insertSchema(organizationId: string, schema: DataSchema): Promise<DataSchema> {
    this.schemas.push({ ...clone(schema), organizationId });
    const dataset = await this.getDataset(organizationId, schema.dataset);
    await this.upsertDataset({
      id: dataset?.id ?? newId("ds"),
      organizationId,
      name: schema.dataset,
      latestSchemaVersion: schema.version,
      createdAt: dataset?.createdAt ?? schema.createdAt,
    });
    return clone(schema);
  }

  // ------------------------------------------------------------------- quality
  async insertQualityResults(results: QualityResultRecord[]): Promise<void> {
    for (const result of results) this.qualityResults.push(clone(result));
  }

  async listQualityResults(
    organizationId: string,
    filter: { runId?: string; dataset?: string; pipelineId?: string; since?: string; limit?: number },
  ): Promise<QualityResultRecord[]> {
    return this.qualityResults
      .filter((r) => r.organizationId === organizationId)
      .filter((r) => (filter.runId ? r.runId === filter.runId : true))
      .filter((r) => (filter.dataset ? r.dataset === filter.dataset : true))
      .filter((r) => (filter.pipelineId ? r.pipelineId === filter.pipelineId : true))
      .filter((r) => (filter.since ? r.createdAt >= filter.since : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 500)
      .map(clone);
  }

  // ------------------------------------------------------------------- lineage
  async replaceLineage(organizationId: string, pipelineVersionId: string, edges: LineageEdgeRecord[]): Promise<void> {
    for (let i = this.lineage.length - 1; i >= 0; i--) {
      const edge = this.lineage[i]!;
      if (edge.organizationId === organizationId && edge.pipelineVersionId === pipelineVersionId) this.lineage.splice(i, 1);
    }
    for (const edge of edges) this.lineage.push(clone(edge));
  }

  async listLineage(organizationId: string, filter: { pipelineId?: string; dataset?: string } = {}): Promise<LineageEdgeRecord[]> {
    return this.lineage
      .filter((e) => e.organizationId === organizationId)
      .filter((e) => (filter.pipelineId ? e.pipelineId === filter.pipelineId : true))
      .filter((e) =>
        filter.dataset
          ? (e.fromType === "dataset" && e.fromId === filter.dataset) || (e.toType === "dataset" && e.toId === filter.dataset)
          : true,
      )
      .map(clone);
  }

  // ----------------------------------------------------------------- incidents
  async upsertIncident(incident: Incident): Promise<Incident> {
    this.incidents.set(this.key(incident.organizationId, incident.id), clone(incident));
    return clone(incident);
  }

  async getIncidentByFingerprint(organizationId: string, fingerprint: string): Promise<Incident | null> {
    return clone(
      [...this.incidents.values()].find(
        (i) => i.organizationId === organizationId && i.fingerprint === fingerprint && i.status !== "resolved",
      ) ?? null,
    );
  }

  async listIncidents(
    organizationId: string,
    filter: PageRequest & { status?: Incident["status"]; kind?: IncidentKind } = {},
  ): Promise<Page<Incident>> {
    const items = [...this.incidents.values()]
      .filter((i) => i.organizationId === organizationId)
      .filter((i) => (filter.status ? i.status === filter.status : true))
      .filter((i) => (filter.kind ? i.kind === filter.kind : true))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.id.localeCompare(a.id));
    return paginate(items.map(clone), { ...filter, value: (i) => i.lastSeenAt, id: (i) => i.id });
  }

  async updateIncident(organizationId: string, incidentId: string, patch: Partial<Incident>): Promise<Incident> {
    const key = this.key(organizationId, incidentId);
    const existing = this.incidents.get(key);
    if (!existing) throw new NotFoundError("Incident", incidentId);
    const updated = { ...existing, ...clone(patch), id: existing.id, organizationId };
    this.incidents.set(key, updated);
    return clone(updated);
  }

  // --------------------------------------------------------------------- audit
  async appendAudit(entry: AuditLogEntry): Promise<AuditLogEntry> {
    this.audit.push(clone(entry));
    return clone(entry);
  }

  async listAudit(
    organizationId: string,
    filter: PageRequest & { action?: string; resourceType?: string; actor?: string } = {},
  ): Promise<Page<AuditLogEntry>> {
    const items = this.audit
      .filter((a) => a.organizationId === organizationId)
      .filter((a) => (filter.action ? a.action === filter.action : true))
      .filter((a) => (filter.resourceType ? a.resourceType === filter.resourceType : true))
      .filter((a) => (filter.actor ? a.actor === filter.actor : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return paginate(items.map(clone), { ...filter, value: (a) => a.createdAt, id: (a) => a.id });
  }

  // ------------------------------------------------------------------ api keys
  async createApiKey(record: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.apiKeys.set(record.id, clone(record));
    return clone(record);
  }

  async getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | null> {
    return clone([...this.apiKeys.values()].find((k) => k.tokenHash === tokenHash) ?? null);
  }

  async listApiKeys(organizationId: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()].filter((k) => k.organizationId === organizationId).map(clone);
  }

  async revokeApiKey(organizationId: string, keyId: string, at: string): Promise<boolean> {
    const key = this.apiKeys.get(keyId);
    if (!key || key.organizationId !== organizationId) return false;
    this.apiKeys.set(keyId, { ...key, revokedAt: at });
    return true;
  }

  async touchApiKey(keyId: string, at: string): Promise<void> {
    const key = this.apiKeys.get(keyId);
    if (key) this.apiKeys.set(keyId, { ...key, lastUsedAt: at });
  }

  // ---------------------------------------------------------- task data plane
  async putTaskData(organizationId: string, runId: string, nodeId: string, batch: unknown): Promise<void> {
    this.taskData.set(`${organizationId}/${runId}/${nodeId}`, clone(batch));
  }

  async getTaskData(organizationId: string, runId: string, nodeId: string): Promise<unknown | null> {
    return clone(this.taskData.get(`${organizationId}/${runId}/${nodeId}`) ?? null);
  }

  async deleteRunData(organizationId: string, runId: string): Promise<void> {
    const prefix = `${organizationId}/${runId}/`;
    for (const key of [...this.taskData.keys()]) {
      if (key.startsWith(prefix)) this.taskData.delete(key);
    }
  }

  // --------------------------------------------------------------------- files
  async putFile(file: UploadedFile, content: Buffer): Promise<UploadedFile> {
    this.files.set(this.key(file.organizationId, file.id), { file: clone(file), content });
    return clone(file);
  }

  async getFile(organizationId: string, fileId: string): Promise<{ file: UploadedFile; content: Buffer } | null> {
    const entry = this.files.get(this.key(organizationId, fileId));
    return entry ? { file: clone(entry.file), content: entry.content } : null;
  }

  async listFiles(organizationId: string): Promise<UploadedFile[]> {
    return [...this.files.values()].filter((f) => f.file.organizationId === organizationId).map((f) => clone(f.file));
  }

  // ----------------------------------------------------------------- analytics
  async runAnalytics(organizationId: string, window: AnalyticsWindow): Promise<RunAnalytics> {
    const runs = [...this.runs.values()]
      .filter((r) => r.organizationId === organizationId)
      .filter((r) => r.queuedAt >= window.from && r.queuedAt <= window.to)
      .filter((r) => (window.pipelineId ? r.pipelineId === window.pipelineId : true));

    const durations = runs.map((r) => r.durationMs).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
    const finished = runs.filter((r) => r.state === "SUCCESS" || r.state === "FAILED");

    const byDate = new Map<string, { succeeded: number; failed: number; cancelled: number; durations: number[] }>();
    for (const run of runs) {
      const date = run.queuedAt.slice(0, 10);
      const bucket = byDate.get(date) ?? { succeeded: 0, failed: 0, cancelled: 0, durations: [] };
      if (run.state === "SUCCESS") bucket.succeeded++;
      else if (run.state === "FAILED") bucket.failed++;
      else if (run.state === "CANCELLED") bucket.cancelled++;
      if (typeof run.durationMs === "number") bucket.durations.push(run.durationMs);
      byDate.set(date, bucket);
    }

    const runIds = new Set(runs.map((r) => r.id));
    const failureCounts = new Map<string, { nodeType: string; failures: number }>();
    for (const task of this.tasks.values()) {
      if (task.organizationId !== organizationId || !runIds.has(task.runId) || task.state !== "FAILED") continue;
      const entry = failureCounts.get(task.nodeId) ?? { nodeType: task.nodeType, failures: 0 };
      entry.failures++;
      failureCounts.set(task.nodeId, entry);
    }

    return {
      totals: {
        runs: runs.length,
        succeeded: runs.filter((r) => r.state === "SUCCESS").length,
        failed: runs.filter((r) => r.state === "FAILED").length,
        cancelled: runs.filter((r) => r.state === "CANCELLED").length,
        running: runs.filter((r) => r.state === "RUNNING" || r.state === "QUEUED").length,
      },
      successRate: finished.length ? finished.filter((r) => r.state === "SUCCESS").length / finished.length : 0,
      averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p95DurationMs: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]! : null,
      series: [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bucket]) => ({
          date,
          succeeded: bucket.succeeded,
          failed: bucket.failed,
          cancelled: bucket.cancelled,
          averageDurationMs: bucket.durations.length
            ? Math.round(bucket.durations.reduce((a, b) => a + b, 0) / bucket.durations.length)
            : null,
        })),
      taskFailures: [...failureCounts.entries()]
        .map(([nodeId, entry]) => ({ nodeId, nodeType: entry.nodeType, failures: entry.failures }))
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 10),
      qualityFailures: this.qualityResults.filter(
        (r) => r.organizationId === organizationId && r.status !== "PASSED" && r.createdAt >= window.from && r.createdAt <= window.to,
      ).length,
    };
  }

  async search(organizationId: string, query: string, limit = 20): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    const score = (text: string): number =>
      text.toLowerCase() === needle ? 3 : text.toLowerCase().startsWith(needle) ? 2 : text.toLowerCase().includes(needle) ? 1 : 0;

    for (const pipeline of this.pipelines.values()) {
      if (pipeline.organizationId !== organizationId) continue;
      const value = Math.max(score(pipeline.name), score(pipeline.description ?? ""));
      if (value) hits.push({ type: "pipeline", id: pipeline.id, title: pipeline.name, ...(pipeline.description ? { subtitle: pipeline.description } : {}), href: `/pipelines/${pipeline.id}`, score: value });
    }
    for (const run of this.runs.values()) {
      if (run.organizationId !== organizationId) continue;
      const value = Math.max(score(run.id), score(run.pipelineName));
      if (value) hits.push({ type: "run", id: run.id, title: run.id, subtitle: `${run.pipelineName} · ${run.state}`, href: `/runs/${run.id}`, score: value });
    }
    for (const dataset of this.datasets.values()) {
      if (dataset.organizationId !== organizationId) continue;
      const value = score(dataset.name);
      if (value) hits.push({ type: "dataset", id: dataset.id, title: dataset.name, href: `/datasets/${encodeURIComponent(dataset.name)}`, score: value });
    }
    for (const incident of this.incidents.values()) {
      if (incident.organizationId !== organizationId) continue;
      const value = score(incident.title);
      if (value) hits.push({ type: "incident", id: incident.id, title: incident.title, subtitle: incident.status, href: `/incidents/${incident.id}`, score: value });
    }
    for (const connection of this.connections.values()) {
      if (connection.organizationId !== organizationId) continue;
      const value = score(connection.name);
      if (value) hits.push({ type: "connection", id: connection.id, title: connection.name, subtitle: connection.family, href: `/connectors/${connection.id}`, score: value });
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}
