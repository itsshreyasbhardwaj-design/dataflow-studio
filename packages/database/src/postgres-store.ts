import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "@dataflow-studio/observability";
import type { DataSchema } from "@dataflow-studio/schema-registry";
import type { SecretRecord } from "@dataflow-studio/secrets";
import type { RunState, TaskState, WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import { clampLimit, decodeCursor, encodeCursor } from "./cursor.js";
import { ConflictError, NotFoundError } from "./memory-store.js";
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

export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface SqlPoolClient extends SqlClient {
  release(): void;
}

export interface SqlPool extends SqlClient {
  connect(): Promise<SqlPoolClient>;
  end(): Promise<void>;
}

// ---------------------------------------------------------------- mapping ---

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (key: string): string => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

const iso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

/** Converts a database row to a domain record, renaming columns as declared. */
function toRecord<T>(row: Record<string, unknown> | undefined, rename: Record<string, string> = {}): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = rename[key] ?? camel(key);
    out[name] = iso(value);
  }
  return out as T;
}

/** Converts a domain record to column/value pairs for an INSERT or UPDATE. */
function toColumns(record: object, rename: Record<string, string> = {}): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    columns.push(rename[key] ?? snake(key));
    values.push(value);
  }
  return { columns, values };
}

function insertSql(table: string, columns: string[], options: { onConflict?: string } = {}): string {
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  return `INSERT INTO ${table} (${columns.map(quote).join(", ")}) VALUES (${placeholders.join(", ")})${options.onConflict ?? ""} RETURNING *`;
}

function updateSql(table: string, columns: string[], where: string, startIndex: number): string {
  const assignments = columns.map((column, i) => `${quote(column)} = $${startIndex + i}`);
  return `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${where} RETURNING *`;
}

/** Quotes a column name; several domain fields collide with SQL keywords. */
function quote(column: string): string {
  return `"${column}"`;
}

const RUN_RENAME = { logical_date: "logicalDate", retry_of_run_id: "retryOfRunId" };
const BACKFILL_TO_DB: Record<string, string> = { from: "range_from", to: "range_to" };
const BACKFILL_FROM_DB: Record<string, string> = { range_from: "from", range_to: "to" };
const QUALITY_TO_DB: Record<string, string> = { column: "column_name" };
const QUALITY_FROM_DB: Record<string, string> = { column_name: "column" };
const LOG_FROM_DB: Record<string, string> = { ts: "timestamp" };

/**
 * PostgreSQL driver.
 *
 * Every statement is organization-scoped and parameterized. The interesting
 * parts are `claimNextTask` (FOR UPDATE SKIP LOCKED, so N workers never collide)
 * and `publishVersion` (a transaction, so a publish cannot leave two published
 * versions behind).
 */
export class PostgresStore implements Store {
  readonly driver = "postgres" as const;

  constructor(private readonly pool: SqlPool) {}

  private async one<T>(text: string, params: readonly unknown[], rename?: Record<string, string>): Promise<T | null> {
    const result = await this.pool.query<Record<string, unknown>>(text, params);
    return toRecord<T>(result.rows[0], rename);
  }

  private async many<T>(text: string, params: readonly unknown[], rename?: Record<string, string>): Promise<T[]> {
    const result = await this.pool.query<Record<string, unknown>>(text, params);
    return result.rows.map((row) => toRecord<T>(row, rename)!);
  }

  private async transaction<T>(fn: (client: SqlPoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const applied = new Set(
      (await this.pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );
    const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      // The RLS migration is opt-in: it requires a non-superuser application role.
      if (file.includes("row_level_security") && process.env["DATAFLOW_ENABLE_RLS"] !== "true") continue;
      if (applied.has(file)) continue;
      const sql = await readFile(join(directory, file), "utf8");
      await this.transaction(async (client) => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      });
    }
  }

  // ------------------------------------------------------------ organizations
  async createOrganization(input: Organization): Promise<Organization> {
    const { columns, values } = toColumns({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
    const row = await this.one<Organization>(insertSql("organizations", columns), values);
    return row!;
  }

  async getOrganization(id: string): Promise<Organization | null> {
    return this.one<Organization>("SELECT * FROM organizations WHERE id = $1", [id]);
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    return this.one<Organization>("SELECT * FROM organizations WHERE slug = $1", [slug]);
  }

  async listOrganizationsForUser(userId: string): Promise<Array<Organization & { role: Role }>> {
    return this.many<Organization & { role: Role }>(
      `SELECT o.*, m.role FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
       WHERE m.user_id = $1 ORDER BY o.created_at ASC`,
      [userId],
    );
  }

  async upsertMember(member: OrganizationMember): Promise<OrganizationMember> {
    const { columns, values } = toColumns(member);
    const updates = columns.filter((c) => c !== "organization_id" && c !== "user_id");
    const row = await this.one<OrganizationMember>(
      insertSql("organization_members", columns, {
        onConflict: ` ON CONFLICT (organization_id, user_id) DO UPDATE SET ${updates.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(", ")}`,
      }),
      values,
    );
    return row!;
  }

  async getMember(organizationId: string, userId: string): Promise<OrganizationMember | null> {
    return this.one<OrganizationMember>(
      "SELECT * FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.many<OrganizationMember>(
      "SELECT * FROM organization_members WHERE organization_id = $1 ORDER BY created_at ASC",
      [organizationId],
    );
  }

  async removeMember(organizationId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------- pipelines
  async createPipeline(pipeline: Pipeline): Promise<Pipeline> {
    const { columns, values } = toColumns(pipeline);
    try {
      return (await this.one<Pipeline>(insertSql("pipelines", columns), values))!;
    } catch (error) {
      throw translate(error, `A pipeline named "${pipeline.name}" already exists`);
    }
  }

  async getPipeline(organizationId: string, pipelineId: string): Promise<Pipeline | null> {
    return this.one<Pipeline>("SELECT * FROM pipelines WHERE organization_id = $1 AND id = $2", [organizationId, pipelineId]);
  }

  async getPipelineByName(organizationId: string, name: string): Promise<Pipeline | null> {
    return this.one<Pipeline>(
      "SELECT * FROM pipelines WHERE organization_id = $1 AND name = $2 AND archived_at IS NULL",
      [organizationId, name],
    );
  }

  async listPipelines(organizationId: string, filter: PipelineFilter = {}): Promise<Page<Pipeline>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    if (!filter.includeArchived) where.push("archived_at IS NULL");
    if (filter.search) {
      params.push(`%${filter.search}%`);
      where.push(`(name ILIKE $${params.length} OR coalesce(description, '') ILIKE $${params.length})`);
    }
    if (filter.tag) {
      params.push(filter.tag);
      where.push(`$${params.length} = ANY(tags)`);
    }
    if (cursor) {
      params.push(cursor.value, cursor.id);
      where.push(`(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const items = await this.many<Pipeline>(
      `SELECT * FROM pipelines WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(items, limit, (p) => p.updatedAt, (p) => p.id);
  }

  async updatePipeline(organizationId: string, pipelineId: string, patch: Partial<Pipeline>): Promise<Pipeline> {
    const { columns, values } = toColumns(patch);
    if (!columns.length) return (await this.getPipeline(organizationId, pipelineId))!;
    const row = await this.one<Pipeline>(
      updateSql("pipelines", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, pipelineId],
    );
    if (!row) throw new NotFoundError("Pipeline", pipelineId);
    return row;
  }

  async deletePipeline(organizationId: string, pipelineId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM pipelines WHERE organization_id = $1 AND id = $2", [organizationId, pipelineId]);
    return (result.rowCount ?? 0) > 0;
  }

  async createVersion(version: PipelineVersion): Promise<PipelineVersion> {
    return this.transaction(async (client) => {
      const { columns, values } = toColumns({
        ...version,
        definition: JSON.stringify(version.definition),
        changeSummary: version.changeSummary ? JSON.stringify(version.changeSummary) : undefined,
      });
      const inserted = toRecord<PipelineVersion>(
        (await client.query<Record<string, unknown>>(insertSql("pipeline_versions", columns), values)).rows[0],
      )!;
      await this.writeDenormalizedGraph(client, version);
      return { ...inserted, definition: version.definition };
    });
  }

  /** Keeps pipeline_nodes / pipeline_edges in step with the definition JSONB. */
  private async writeDenormalizedGraph(client: SqlClient, version: PipelineVersion): Promise<void> {
    await client.query("DELETE FROM pipeline_nodes WHERE pipeline_version_id = $1", [version.id]);
    await client.query("DELETE FROM pipeline_edges WHERE pipeline_version_id = $1", [version.id]);
    for (const node of version.definition.nodes) {
      await client.query(
        `INSERT INTO pipeline_nodes (organization_id, pipeline_version_id, node_id, node_type, dataset, config)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          version.organizationId, version.id, node.id, node.type,
          typeof node.config?.["dataset"] === "string" ? node.config["dataset"] : null,
          JSON.stringify(node.config ?? {}),
        ],
      );
    }
    for (const edge of version.definition.edges) {
      await client.query(
        `INSERT INTO pipeline_edges (organization_id, pipeline_version_id, from_node, to_node, port)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [version.organizationId, version.id, edge.from, edge.to, edge.port ?? "default"],
      );
    }
  }

  async getVersion(organizationId: string, versionId: string): Promise<PipelineVersion | null> {
    return this.one<PipelineVersion>(
      "SELECT * FROM pipeline_versions WHERE organization_id = $1 AND id = $2",
      [organizationId, versionId],
    );
  }

  async getVersionByNumber(organizationId: string, pipelineId: string, version: number): Promise<PipelineVersion | null> {
    return this.one<PipelineVersion>(
      "SELECT * FROM pipeline_versions WHERE organization_id = $1 AND pipeline_id = $2 AND version = $3",
      [organizationId, pipelineId, version],
    );
  }

  async listVersions(organizationId: string, pipelineId: string): Promise<PipelineVersion[]> {
    return this.many<PipelineVersion>(
      "SELECT * FROM pipeline_versions WHERE organization_id = $1 AND pipeline_id = $2 ORDER BY version DESC",
      [organizationId, pipelineId],
    );
  }

  async updateVersion(organizationId: string, versionId: string, patch: Partial<PipelineVersion>): Promise<PipelineVersion> {
    const { columns, values } = toColumns({
      ...patch,
      ...(patch.definition ? { definition: JSON.stringify(patch.definition) } : {}),
      ...(patch.changeSummary ? { changeSummary: JSON.stringify(patch.changeSummary) } : {}),
    });
    if (!columns.length) return (await this.getVersion(organizationId, versionId))!;
    const row = await this.one<PipelineVersion>(
      updateSql("pipeline_versions", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, versionId],
    );
    if (!row) throw new NotFoundError("Pipeline version", versionId);
    return row;
  }

  async publishVersion(organizationId: string, pipelineId: string, versionId: string, at: string): Promise<PipelineVersion> {
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE pipeline_versions SET status = 'deprecated', deprecated_at = $1
         WHERE organization_id = $2 AND pipeline_id = $3 AND status = 'published' AND id <> $4`,
        [at, organizationId, pipelineId, versionId],
      );
      const result = await client.query<Record<string, unknown>>(
        `UPDATE pipeline_versions SET status = 'published', published_at = $1
         WHERE organization_id = $2 AND pipeline_id = $3 AND id = $4 RETURNING *`,
        [at, organizationId, pipelineId, versionId],
      );
      if (!result.rows[0]) throw new NotFoundError("Pipeline version", versionId);
      await client.query(
        "UPDATE pipelines SET published_version_id = $1, updated_at = $2 WHERE organization_id = $3 AND id = $4",
        [versionId, at, organizationId, pipelineId],
      );
      return toRecord<PipelineVersion>(result.rows[0])!;
    });
  }

  // ---------------------------------------------------------------------- runs
  async createRun(run: WorkflowRun, tasks: TaskRun[]): Promise<WorkflowRun> {
    return this.transaction(async (client) => {
      const { columns, values } = toColumns({
        ...run,
        params: run.params ? JSON.stringify(run.params) : undefined,
        totals: run.totals ? JSON.stringify(run.totals) : undefined,
      });
      const inserted = toRecord<WorkflowRun>(
        (await client.query<Record<string, unknown>>(insertSql("workflow_runs", columns), values)).rows[0],
        RUN_RENAME,
      )!;
      for (const task of tasks) {
        const task$ = toColumns({ ...task, output: task.output ? JSON.stringify(task.output) : undefined });
        await client.query(insertSql("task_runs", task$.columns), task$.values);
      }
      return inserted;
    });
  }

  async getRun(organizationId: string, runId: string): Promise<WorkflowRun | null> {
    return this.one<WorkflowRun>("SELECT * FROM workflow_runs WHERE organization_id = $1 AND id = $2", [organizationId, runId], RUN_RENAME);
  }

  async listRuns(organizationId: string, filter: RunFilter = {}): Promise<Page<WorkflowRun>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    const add = (clause: (index: number) => string, value: unknown): void => {
      params.push(value);
      where.push(clause(params.length));
    };
    if (filter.pipelineId) add((i) => `pipeline_id = $${i}`, filter.pipelineId);
    if (filter.state) add((i) => `state = ANY($${i})`, Array.isArray(filter.state) ? filter.state : [filter.state]);
    if (filter.trigger) add((i) => `trigger = $${i}`, filter.trigger);
    if (filter.backfillId) add((i) => `backfill_id = $${i}`, filter.backfillId);
    if (filter.scheduleId) add((i) => `schedule_id = $${i}`, filter.scheduleId);
    if (filter.since) add((i) => `queued_at >= $${i}::timestamptz`, filter.since);
    if (filter.until) add((i) => `queued_at <= $${i}::timestamptz`, filter.until);
    if (cursor) {
      params.push(cursor.value, cursor.id);
      where.push(`(queued_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const items = await this.many<WorkflowRun>(
      `SELECT * FROM workflow_runs WHERE ${where.join(" AND ")} ORDER BY queued_at DESC, id DESC LIMIT $${params.length}`,
      params,
      RUN_RENAME,
    );
    return page(items, limit, (r) => r.queuedAt, (r) => r.id);
  }

  async updateRun(organizationId: string, runId: string, patch: Partial<WorkflowRun>): Promise<WorkflowRun> {
    const { columns, values } = toColumns({
      ...patch,
      ...(patch.params ? { params: JSON.stringify(patch.params) } : {}),
      ...(patch.totals ? { totals: JSON.stringify(patch.totals) } : {}),
    });
    if (!columns.length) return (await this.getRun(organizationId, runId))!;
    const row = await this.one<WorkflowRun>(
      updateSql("workflow_runs", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, runId],
      RUN_RENAME,
    );
    if (!row) throw new NotFoundError("Run", runId);
    return row;
  }

  async latestRunPerPipeline(organizationId: string, pipelineIds: string[]): Promise<Record<string, WorkflowRun>> {
    if (!pipelineIds.length) return {};
    // DISTINCT ON keeps this a single index scan instead of N queries.
    const rows = await this.many<WorkflowRun>(
      `SELECT DISTINCT ON (pipeline_id) * FROM workflow_runs
       WHERE organization_id = $1 AND pipeline_id = ANY($2)
       ORDER BY pipeline_id, queued_at DESC`,
      [organizationId, pipelineIds],
      RUN_RENAME,
    );
    return Object.fromEntries(rows.map((run) => [run.pipelineId, run]));
  }

  async countRunsByState(organizationId: string): Promise<Record<RunState, number>> {
    const rows = await this.pool.query<{ state: RunState; count: string }>(
      "SELECT state, count(*)::text AS count FROM workflow_runs WHERE organization_id = $1 GROUP BY state",
      [organizationId],
    );
    const counts = { PENDING: 0, QUEUED: 0, RUNNING: 0, SUCCESS: 0, FAILED: 0, CANCELLED: 0 } as Record<RunState, number>;
    for (const row of rows.rows) counts[row.state] = Number(row.count);
    return counts;
  }

  async listTasks(organizationId: string, runId: string): Promise<TaskRun[]> {
    return this.many<TaskRun>(
      "SELECT * FROM task_runs WHERE organization_id = $1 AND run_id = $2 ORDER BY node_id ASC",
      [organizationId, runId],
    );
  }

  async getTask(organizationId: string, taskRunId: string): Promise<TaskRun | null> {
    return this.one<TaskRun>("SELECT * FROM task_runs WHERE organization_id = $1 AND id = $2", [organizationId, taskRunId]);
  }

  async updateTask(organizationId: string, taskRunId: string, patch: Partial<TaskRun>): Promise<TaskRun> {
    const { columns, values } = toColumns({ ...patch, ...(patch.output ? { output: JSON.stringify(patch.output) } : {}) });
    if (!columns.length) return (await this.getTask(organizationId, taskRunId))!;
    const row = await this.one<TaskRun>(
      updateSql("task_runs", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, taskRunId],
    );
    if (!row) throw new NotFoundError("Task", taskRunId);
    return row;
  }

  async compareAndSetTaskState(
    organizationId: string,
    taskRunId: string,
    expected: TaskState | TaskState[],
    patch: Partial<TaskRun> & { state: TaskState },
  ): Promise<TaskRun | null> {
    const { columns, values } = toColumns({ ...patch, ...(patch.output ? { output: JSON.stringify(patch.output) } : {}) });
    const base = columns.length;
    return this.one<TaskRun>(
      updateSql("task_runs", columns, `organization_id = $${base + 1} AND id = $${base + 2} AND state = ANY($${base + 3})`, 1),
      [...values, organizationId, taskRunId, Array.isArray(expected) ? expected : [expected]],
    );
  }

  async claimNextTask(options: ClaimOptions): Promise<TaskRun | null> {
    const now = options.now ?? new Date();
    const lease = new Date(now.getTime() + options.leaseSeconds * 1000);
    // SKIP LOCKED is what makes horizontal scaling safe: two workers racing for
    // the same row simply take different rows instead of blocking or double-running.
    return this.one<TaskRun>(
      `UPDATE task_runs SET state = 'RUNNING', worker_id = $1, lease_expires_at = $2,
              started_at = coalesce(started_at, $3)
       WHERE id = (
         SELECT id FROM task_runs
         WHERE state IN ('QUEUED', 'RETRYING')
           AND scheduled_at <= $3
           AND ($4::text[] IS NULL OR node_type = ANY($4))
         ORDER BY priority DESC, scheduled_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [options.workerId, lease, now, options.nodeTypes ?? null],
    );
  }

  async reclaimExpiredLeases(now: Date = new Date()): Promise<TaskRun[]> {
    return this.many<TaskRun>(
      `UPDATE task_runs SET state = 'QUEUED', worker_id = NULL, lease_expires_at = NULL
       WHERE state = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
       RETURNING *`,
      [now],
    );
  }

  async extendLease(organizationId: string, taskRunId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_runs SET lease_expires_at = now() + make_interval(secs => $1)
       WHERE organization_id = $2 AND id = $3 AND worker_id = $4 AND state = 'RUNNING'`,
      [leaseSeconds, organizationId, taskRunId, workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendAttempt(attempt: TaskAttempt): Promise<TaskAttempt> {
    const { columns, values } = toColumns({ ...attempt, output: attempt.output ? JSON.stringify(attempt.output) : undefined });
    return (await this.one<TaskAttempt>(
      insertSql("task_attempts", columns, { onConflict: " ON CONFLICT (task_run_id, attempt) DO UPDATE SET state = EXCLUDED.state, finished_at = EXCLUDED.finished_at, duration_ms = EXCLUDED.duration_ms, error = EXCLUDED.error, error_class = EXCLUDED.error_class, output = EXCLUDED.output" }),
      values,
    ))!;
  }

  async listAttempts(organizationId: string, taskRunId: string): Promise<TaskAttempt[]> {
    return this.many<TaskAttempt>(
      "SELECT * FROM task_attempts WHERE organization_id = $1 AND task_run_id = $2 ORDER BY attempt ASC",
      [organizationId, taskRunId],
    );
  }

  async appendLogs(entries: TaskLogEntry[]): Promise<void> {
    if (!entries.length) return;
    // One multi-row INSERT: log volume is the hottest write path in the system.
    const params: unknown[] = [];
    const tuples = entries.map((entry) => {
      params.push(entry.organizationId, entry.runId, entry.taskRunId, entry.attempt, entry.timestamp, entry.level, entry.message, entry.fields ? JSON.stringify(entry.fields) : null);
      const base = params.length - 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::timestamptz, $${base + 6}, $${base + 7}, $${base + 8})`;
    });
    await this.pool.query(
      `INSERT INTO task_logs (organization_id, run_id, task_run_id, attempt, ts, level, message, fields) VALUES ${tuples.join(", ")}`,
      params,
    );
  }

  async listLogs(organizationId: string, runId: string, filter: LogFilter = {}): Promise<Page<TaskLogEntry>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId, runId];
    const where = ["organization_id = $1", "run_id = $2"];
    const add = (clause: (i: number) => string, value: unknown): void => {
      params.push(value);
      where.push(clause(params.length));
    };
    if (filter.taskRunId) add((i) => `task_run_id = $${i}`, filter.taskRunId);
    if (filter.attempt !== undefined) add((i) => `attempt = $${i}`, filter.attempt);
    if (filter.level) add((i) => `level = $${i}`, filter.level);
    if (filter.since) add((i) => `ts >= $${i}::timestamptz`, filter.since);
    if (filter.search) add((i) => `message ILIKE $${i}`, `%${filter.search}%`);
    if (cursor) {
      params.push(cursor.value, cursor.id);
      where.push(`(ts, id::text) > ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const items = await this.many<TaskLogEntry>(
      `SELECT * FROM task_logs WHERE ${where.join(" AND ")} ORDER BY ts ASC, id ASC LIMIT $${params.length}`,
      params,
      LOG_FROM_DB,
    );
    return page(items, limit, (l) => l.timestamp, (l) => String(l.id));
  }

  async appendRunEvent(event: Omit<RunEvent, "id" | "sequence" | "createdAt"> & { createdAt?: string }): Promise<RunEvent> {
    const row = await this.one<RunEvent>(
      `INSERT INTO run_events (organization_id, run_id, sequence, type, payload, created_at)
       VALUES ($1, $2, (SELECT coalesce(max(sequence), 0) + 1 FROM run_events WHERE run_id = $2), $3, $4, coalesce($5::timestamptz, now()))
       RETURNING *`,
      [event.organizationId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt ?? null],
    );
    return row!;
  }

  async listRunEvents(organizationId: string, runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return this.many<RunEvent>(
      "SELECT * FROM run_events WHERE organization_id = $1 AND run_id = $2 AND sequence > $3 ORDER BY sequence ASC",
      [organizationId, runId, afterSequence],
    );
  }

  // ----------------------------------------------------------------- schedules
  async createSchedule(schedule: Schedule): Promise<Schedule> {
    const { columns, values } = toColumns(schedule);
    return (await this.one<Schedule>(insertSql("schedules", columns), values))!;
  }

  async getSchedule(organizationId: string, scheduleId: string): Promise<Schedule | null> {
    return this.one<Schedule>("SELECT * FROM schedules WHERE organization_id = $1 AND id = $2", [organizationId, scheduleId]);
  }

  async listSchedules(organizationId: string, pipelineId?: string): Promise<Schedule[]> {
    return pipelineId
      ? this.many<Schedule>("SELECT * FROM schedules WHERE organization_id = $1 AND pipeline_id = $2 ORDER BY next_run_at ASC", [organizationId, pipelineId])
      : this.many<Schedule>("SELECT * FROM schedules WHERE organization_id = $1 ORDER BY next_run_at ASC", [organizationId]);
  }

  async updateSchedule(organizationId: string, scheduleId: string, patch: Partial<Schedule>): Promise<Schedule> {
    const { columns, values } = toColumns(patch);
    if (!columns.length) return (await this.getSchedule(organizationId, scheduleId))!;
    const row = await this.one<Schedule>(
      updateSql("schedules", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, scheduleId],
    );
    if (!row) throw new NotFoundError("Schedule", scheduleId);
    return row;
  }

  async deleteSchedule(organizationId: string, scheduleId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM schedules WHERE organization_id = $1 AND id = $2", [organizationId, scheduleId]);
    return (result.rowCount ?? 0) > 0;
  }

  async claimDueSchedules(now: Date, limit = 50): Promise<Schedule[]> {
    return this.many<Schedule>(
      `SELECT * FROM schedules WHERE enabled AND next_run_at <= $1
       ORDER BY next_run_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, clampLimit(limit)],
    );
  }

  async createBackfill(backfill: Backfill): Promise<Backfill> {
    const { columns, values } = toColumns(
      { ...backfill, pendingDates: JSON.stringify(backfill.pendingDates) },
      BACKFILL_TO_DB,
    );
    return (await this.one<Backfill>(insertSql("backfills", columns), values, BACKFILL_FROM_DB))!;
  }

  async getBackfill(organizationId: string, backfillId: string): Promise<Backfill | null> {
    return this.one<Backfill>("SELECT * FROM backfills WHERE organization_id = $1 AND id = $2", [organizationId, backfillId], BACKFILL_FROM_DB);
  }

  async listBackfills(organizationId: string, pipelineId?: string): Promise<Backfill[]> {
    return pipelineId
      ? this.many<Backfill>("SELECT * FROM backfills WHERE organization_id = $1 AND pipeline_id = $2 ORDER BY created_at DESC", [organizationId, pipelineId], BACKFILL_FROM_DB)
      : this.many<Backfill>("SELECT * FROM backfills WHERE organization_id = $1 ORDER BY created_at DESC", [organizationId], BACKFILL_FROM_DB);
  }

  async updateBackfill(organizationId: string, backfillId: string, patch: Partial<Backfill>): Promise<Backfill> {
    const { columns, values } = toColumns(
      { ...patch, ...(patch.pendingDates ? { pendingDates: JSON.stringify(patch.pendingDates) } : {}) },
      BACKFILL_TO_DB,
    );
    if (!columns.length) return (await this.getBackfill(organizationId, backfillId))!;
    const row = await this.one<Backfill>(
      updateSql("backfills", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, backfillId],
      BACKFILL_FROM_DB,
    );
    if (!row) throw new NotFoundError("Backfill", backfillId);
    return row;
  }

  async listActiveBackfills(limit = 20): Promise<Backfill[]> {
    return this.many<Backfill>(
      "SELECT * FROM backfills WHERE state IN ('pending','running') ORDER BY created_at ASC LIMIT $1",
      [limit],
      BACKFILL_FROM_DB,
    );
  }

  // ---------------------------------------------------------------- connectors
  async createConnection(connection: Connection): Promise<Connection> {
    const { columns, values } = toColumns({
      ...connection,
      config: JSON.stringify(connection.config),
      secretRefs: JSON.stringify(connection.secretRefs),
    });
    try {
      return (await this.one<Connection>(insertSql("connectors", columns), values))!;
    } catch (error) {
      throw translate(error, `A connection named "${connection.name}" already exists`);
    }
  }

  async getConnection(organizationId: string, connectionId: string): Promise<Connection | null> {
    return this.one<Connection>("SELECT * FROM connectors WHERE organization_id = $1 AND id = $2", [organizationId, connectionId]);
  }

  async listConnections(organizationId: string): Promise<Connection[]> {
    return this.many<Connection>("SELECT * FROM connectors WHERE organization_id = $1 ORDER BY name ASC", [organizationId]);
  }

  async updateConnection(organizationId: string, connectionId: string, patch: Partial<Connection>): Promise<Connection> {
    const { columns, values } = toColumns({
      ...patch,
      ...(patch.config ? { config: JSON.stringify(patch.config) } : {}),
      ...(patch.secretRefs ? { secretRefs: JSON.stringify(patch.secretRefs) } : {}),
    });
    if (!columns.length) return (await this.getConnection(organizationId, connectionId))!;
    const row = await this.one<Connection>(
      updateSql("connectors", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, connectionId],
    );
    if (!row) throw new NotFoundError("Connection", connectionId);
    return row;
  }

  async deleteConnection(organizationId: string, connectionId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM connectors WHERE organization_id = $1 AND id = $2", [organizationId, connectionId]);
    return (result.rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------- secrets
  async getSecret(organizationId: string, name: string): Promise<SecretRecord | null> {
    return this.one<SecretRecord>(
      "SELECT * FROM connector_credentials WHERE organization_id = $1 AND name = $2",
      [organizationId, name],
    );
  }

  async listSecrets(organizationId: string): Promise<SecretRecord[]> {
    return this.many<SecretRecord>(
      "SELECT * FROM connector_credentials WHERE organization_id = $1 ORDER BY name ASC",
      [organizationId],
    );
  }

  async upsertSecret(record: SecretRecord): Promise<SecretRecord> {
    const { columns, values } = toColumns(record);
    const updates = columns.filter((c) => c !== "organization_id" && c !== "name");
    return (await this.one<SecretRecord>(
      insertSql("connector_credentials", columns, {
        onConflict: ` ON CONFLICT (organization_id, name) DO UPDATE SET ${updates.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(", ")}`,
      }),
      values,
    ))!;
  }

  async deleteSecret(organizationId: string, name: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM connector_credentials WHERE organization_id = $1 AND name = $2", [organizationId, name]);
    return (result.rowCount ?? 0) > 0;
  }

  async touchSecret(organizationId: string, name: string, at: string): Promise<void> {
    await this.pool.query("UPDATE connector_credentials SET last_used_at = $1 WHERE organization_id = $2 AND name = $3", [at, organizationId, name]);
  }

  // ------------------------------------------------------------------ datasets
  async upsertDataset(dataset: Dataset): Promise<Dataset> {
    const { columns, values } = toColumns({
      ...dataset,
      previewRows: dataset.previewRows ? JSON.stringify(dataset.previewRows) : undefined,
      previewColumns: dataset.previewColumns ? JSON.stringify(dataset.previewColumns) : undefined,
    });
    const updates = columns.filter((c) => c !== "organization_id" && c !== "name" && c !== "id" && c !== "created_at");
    return (await this.one<Dataset>(
      insertSql("datasets", columns, {
        onConflict: updates.length
          ? ` ON CONFLICT (organization_id, name) DO UPDATE SET ${updates.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(", ")}`
          : " ON CONFLICT (organization_id, name) DO NOTHING",
      }),
      values,
    ))!;
  }

  async getDataset(organizationId: string, name: string): Promise<Dataset | null> {
    return this.one<Dataset>("SELECT * FROM datasets WHERE organization_id = $1 AND name = $2", [organizationId, name]);
  }

  async listDatasets(organizationId: string, filter: PageRequest & { search?: string } = {}): Promise<Page<Dataset>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    if (filter.search) {
      params.push(`%${filter.search}%`);
      where.push(`name ILIKE $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.value);
      where.push(`name > $${params.length}`);
    }
    params.push(limit + 1);
    const items = await this.many<Dataset>(
      `SELECT * FROM datasets WHERE ${where.join(" AND ")} ORDER BY name ASC LIMIT $${params.length}`,
      params,
    );
    return page(items, limit, (d) => d.name, (d) => d.id);
  }

  async putDataset(
    organizationId: string,
    dataset: string,
    payload: { rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number; writeMode: "append" | "replace"; runId?: string },
  ): Promise<{ rowCount: number }> {
    return this.transaction(async (client) => {
      const existing = (await client.query<{ rows: unknown; row_count: string }>(
        "SELECT rows, row_count FROM dataset_rows WHERE organization_id = $1 AND dataset = $2 FOR UPDATE",
        [organizationId, dataset],
      )).rows[0];

      const previousRows = (existing?.rows as Array<Record<string, unknown>> | undefined) ?? [];
      const rows = payload.writeMode === "append" ? [...previousRows, ...payload.rows] : payload.rows;
      const rowCount = payload.writeMode === "append" ? Number(existing?.row_count ?? 0) + payload.rowCount : payload.rowCount;

      await client.query(
        `INSERT INTO dataset_rows (organization_id, dataset, rows, columns, row_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (organization_id, dataset) DO UPDATE
           SET rows = EXCLUDED.rows, columns = EXCLUDED.columns, row_count = EXCLUDED.row_count, updated_at = now()`,
        [organizationId, dataset, JSON.stringify(rows), JSON.stringify(payload.columns), rowCount],
      );
      await client.query(
        `INSERT INTO datasets (id, organization_id, name, row_count, preview_rows, preview_columns, last_updated_at, last_run_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now())
         ON CONFLICT (organization_id, name) DO UPDATE
           SET row_count = EXCLUDED.row_count, preview_rows = EXCLUDED.preview_rows,
               preview_columns = EXCLUDED.preview_columns, last_updated_at = now(), last_run_id = EXCLUDED.last_run_id`,
        [newId("ds"), organizationId, dataset, rowCount, JSON.stringify(rows.slice(0, 100)), JSON.stringify(payload.columns), payload.runId ?? null],
      );
      return { rowCount };
    });
  }

  async getDatasetRows(organizationId: string, dataset: string) {
    const row = (await this.pool.query<{ rows: Array<Record<string, unknown>>; columns: unknown[]; row_count: string }>(
      "SELECT rows, columns, row_count FROM dataset_rows WHERE organization_id = $1 AND dataset = $2",
      [organizationId, dataset],
    )).rows[0];
    return row ? { rows: row.rows, columns: row.columns, rowCount: Number(row.row_count) } : null;
  }

  async latestSchema(organizationId: string, dataset: string): Promise<DataSchema | null> {
    return this.one<DataSchema>(
      "SELECT dataset, version, columns, fingerprint, created_at, observed_in_run_id FROM schema_versions WHERE organization_id = $1 AND dataset = $2 ORDER BY version DESC LIMIT 1",
      [organizationId, dataset],
    );
  }

  async listSchemaVersions(organizationId: string, dataset: string): Promise<DataSchema[]> {
    return this.many<DataSchema>(
      "SELECT dataset, version, columns, fingerprint, created_at, observed_in_run_id FROM schema_versions WHERE organization_id = $1 AND dataset = $2 ORDER BY version ASC",
      [organizationId, dataset],
    );
  }

  async insertSchema(organizationId: string, schema: DataSchema): Promise<DataSchema> {
    await this.pool.query(
      `INSERT INTO schema_versions (organization_id, dataset, version, columns, fingerprint, observed_in_run_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, dataset, version) DO NOTHING`,
      [organizationId, schema.dataset, schema.version, JSON.stringify(schema.columns), schema.fingerprint, schema.observedInRunId ?? null, schema.createdAt],
    );
    await this.pool.query(
      `INSERT INTO datasets (id, organization_id, name, latest_schema_version, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (organization_id, name) DO UPDATE SET latest_schema_version = EXCLUDED.latest_schema_version`,
      [newId("ds"), organizationId, schema.dataset, schema.version],
    );
    return schema;
  }

  // ------------------------------------------------------------------- quality
  async insertQualityResults(results: QualityResultRecord[]): Promise<void> {
    if (!results.length) return;
    for (const result of results) {
      const { columns, values } = toColumns(
        { ...result, failedSamples: result.failedSamples ? JSON.stringify(result.failedSamples) : undefined },
        QUALITY_TO_DB,
      );
      await this.pool.query(insertSql("quality_results", columns), values);
    }
  }

  async listQualityResults(
    organizationId: string,
    filter: { runId?: string; dataset?: string; pipelineId?: string; since?: string; limit?: number },
  ): Promise<QualityResultRecord[]> {
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    const add = (clause: (i: number) => string, value: unknown): void => {
      params.push(value);
      where.push(clause(params.length));
    };
    if (filter.runId) add((i) => `run_id = $${i}`, filter.runId);
    if (filter.dataset) add((i) => `dataset = $${i}`, filter.dataset);
    if (filter.pipelineId) add((i) => `pipeline_id = $${i}`, filter.pipelineId);
    if (filter.since) add((i) => `created_at >= $${i}::timestamptz`, filter.since);
    params.push(filter.limit ?? 500);
    return this.many<QualityResultRecord>(
      `SELECT * FROM quality_results WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
      QUALITY_FROM_DB,
    );
  }

  // ------------------------------------------------------------------- lineage
  async replaceLineage(organizationId: string, pipelineVersionId: string, edges: LineageEdgeRecord[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM lineage_edges WHERE organization_id = $1 AND pipeline_version_id = $2", [organizationId, pipelineVersionId]);
      for (const edge of edges) {
        const { columns, values } = toColumns(edge);
        await client.query(insertSql("lineage_edges", columns, { onConflict: " ON CONFLICT DO NOTHING" }), values);
      }
    });
  }

  async listLineage(organizationId: string, filter: { pipelineId?: string; dataset?: string } = {}): Promise<LineageEdgeRecord[]> {
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    if (filter.pipelineId) {
      params.push(filter.pipelineId);
      where.push(`pipeline_id = $${params.length}`);
    }
    if (filter.dataset) {
      params.push(filter.dataset);
      where.push(`((from_type = 'dataset' AND from_id = $${params.length}) OR (to_type = 'dataset' AND to_id = $${params.length}))`);
    }
    return this.many<LineageEdgeRecord>(`SELECT * FROM lineage_edges WHERE ${where.join(" AND ")}`, params);
  }

  // ----------------------------------------------------------------- incidents
  async upsertIncident(incident: Incident): Promise<Incident> {
    const { columns, values } = toColumns({ ...incident, evidence: JSON.stringify(incident.evidence) });
    const updates = ["severity", "title", "evidence", "occurrences", "last_seen_at", "status", "run_id", "acknowledged_by", "resolved_at"]
      .filter((c) => columns.includes(c));
    return (await this.one<Incident>(
      insertSql("incidents", columns, {
        onConflict: ` ON CONFLICT (organization_id, fingerprint) WHERE status <> 'resolved' DO UPDATE SET ${updates.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(", ")}`,
      }),
      values,
    ))!;
  }

  async getIncidentByFingerprint(organizationId: string, fingerprint: string): Promise<Incident | null> {
    return this.one<Incident>(
      "SELECT * FROM incidents WHERE organization_id = $1 AND fingerprint = $2 AND status <> 'resolved'",
      [organizationId, fingerprint],
    );
  }

  async listIncidents(
    organizationId: string,
    filter: PageRequest & { status?: Incident["status"]; kind?: IncidentKind } = {},
  ): Promise<Page<Incident>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    if (filter.kind) { params.push(filter.kind); where.push(`kind = $${params.length}`); }
    if (cursor) {
      params.push(cursor.value, cursor.id);
      where.push(`(last_seen_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const items = await this.many<Incident>(
      `SELECT * FROM incidents WHERE ${where.join(" AND ")} ORDER BY last_seen_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(items, limit, (i) => i.lastSeenAt, (i) => i.id);
  }

  async updateIncident(organizationId: string, incidentId: string, patch: Partial<Incident>): Promise<Incident> {
    const { columns, values } = toColumns({ ...patch, ...(patch.evidence ? { evidence: JSON.stringify(patch.evidence) } : {}) });
    if (!columns.length) return (await this.one<Incident>("SELECT * FROM incidents WHERE organization_id = $1 AND id = $2", [organizationId, incidentId]))!;
    const row = await this.one<Incident>(
      updateSql("incidents", columns, `organization_id = $${columns.length + 1} AND id = $${columns.length + 2}`, 1),
      [...values, organizationId, incidentId],
    );
    if (!row) throw new NotFoundError("Incident", incidentId);
    return row;
  }

  // --------------------------------------------------------------------- audit
  async appendAudit(entry: AuditLogEntry): Promise<AuditLogEntry> {
    const { columns, values } = toColumns({ ...entry, metadata: entry.metadata ? JSON.stringify(entry.metadata) : undefined });
    return (await this.one<AuditLogEntry>(insertSql("audit_logs", columns), values))!;
  }

  async listAudit(
    organizationId: string,
    filter: PageRequest & { action?: string; resourceType?: string; actor?: string } = {},
  ): Promise<Page<AuditLogEntry>> {
    const limit = clampLimit(filter.limit);
    const cursor = decodeCursor(filter.cursor);
    const params: unknown[] = [organizationId];
    const where = ["organization_id = $1"];
    if (filter.action) { params.push(filter.action); where.push(`action = $${params.length}`); }
    if (filter.resourceType) { params.push(filter.resourceType); where.push(`resource_type = $${params.length}`); }
    if (filter.actor) { params.push(filter.actor); where.push(`actor = $${params.length}`); }
    if (cursor) {
      params.push(cursor.value, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    params.push(limit + 1);
    const items = await this.many<AuditLogEntry>(
      `SELECT * FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(items, limit, (a) => a.createdAt, (a) => a.id);
  }

  // ------------------------------------------------------------------ api keys
  async createApiKey(record: ApiKeyRecord): Promise<ApiKeyRecord> {
    const { columns, values } = toColumns(record);
    return (await this.one<ApiKeyRecord>(insertSql("api_keys", columns), values))!;
  }

  async getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | null> {
    return this.one<ApiKeyRecord>("SELECT * FROM api_keys WHERE token_hash = $1", [tokenHash]);
  }

  async listApiKeys(organizationId: string): Promise<ApiKeyRecord[]> {
    return this.many<ApiKeyRecord>("SELECT * FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC", [organizationId]);
  }

  async revokeApiKey(organizationId: string, keyId: string, at: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE api_keys SET revoked_at = $1 WHERE organization_id = $2 AND id = $3 AND revoked_at IS NULL",
      [at, organizationId, keyId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async touchApiKey(keyId: string, at: string): Promise<void> {
    await this.pool.query("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [at, keyId]);
  }

  // ---------------------------------------------------------- task data plane
  async putTaskData(organizationId: string, runId: string, nodeId: string, batch: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_data (organization_id, run_id, node_id, batch, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (organization_id, run_id, node_id) DO UPDATE SET batch = EXCLUDED.batch, created_at = now()`,
      [organizationId, runId, nodeId, JSON.stringify(batch)],
    );
  }

  async getTaskData(organizationId: string, runId: string, nodeId: string): Promise<unknown | null> {
    const row = (await this.pool.query<{ batch: unknown }>(
      "SELECT batch FROM task_data WHERE organization_id = $1 AND run_id = $2 AND node_id = $3",
      [organizationId, runId, nodeId],
    )).rows[0];
    return row?.batch ?? null;
  }

  async deleteRunData(organizationId: string, runId: string): Promise<void> {
    await this.pool.query("DELETE FROM task_data WHERE organization_id = $1 AND run_id = $2", [organizationId, runId]);
  }

  // --------------------------------------------------------------------- files
  async putFile(file: UploadedFile, content: Buffer): Promise<UploadedFile> {
    const row = await this.one<UploadedFile>(
      `INSERT INTO uploaded_files (id, organization_id, filename, content_type, bytes, content, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
       RETURNING id, organization_id, filename, content_type, bytes, created_by, created_at`,
      [file.id, file.organizationId, file.filename, file.contentType ?? null, file.bytes, content, file.createdBy, file.createdAt ?? null],
    );
    return row!;
  }

  async getFile(organizationId: string, fileId: string): Promise<{ file: UploadedFile; content: Buffer } | null> {
    const row = (await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM uploaded_files WHERE organization_id = $1 AND id = $2",
      [organizationId, fileId],
    )).rows[0];
    if (!row) return null;
    const content = row["content"] as Buffer;
    delete row["content"];
    return { file: toRecord<UploadedFile>(row)!, content };
  }

  async listFiles(organizationId: string): Promise<UploadedFile[]> {
    return this.many<UploadedFile>(
      "SELECT id, organization_id, filename, content_type, bytes, created_by, created_at FROM uploaded_files WHERE organization_id = $1 ORDER BY created_at DESC",
      [organizationId],
    );
  }

  // ----------------------------------------------------------------- analytics
  async runAnalytics(organizationId: string, window: AnalyticsWindow): Promise<RunAnalytics> {
    const params: unknown[] = [organizationId, window.from, window.to];
    const pipelineClause = window.pipelineId ? " AND pipeline_id = $4" : "";
    if (window.pipelineId) params.push(window.pipelineId);

    const totals = (await this.pool.query<Record<string, string>>(
      `SELECT
         count(*)::text AS runs,
         count(*) FILTER (WHERE state = 'SUCCESS')::text AS succeeded,
         count(*) FILTER (WHERE state = 'FAILED')::text AS failed,
         count(*) FILTER (WHERE state = 'CANCELLED')::text AS cancelled,
         count(*) FILTER (WHERE state IN ('RUNNING','QUEUED'))::text AS running,
         avg(duration_ms)::text AS avg_duration,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95_duration
       FROM workflow_runs
       WHERE organization_id = $1 AND queued_at >= $2::timestamptz AND queued_at <= $3::timestamptz${pipelineClause}`,
      params,
    )).rows[0]!;

    const series = (await this.pool.query<Record<string, string>>(
      `SELECT to_char(date_trunc('day', queued_at), 'YYYY-MM-DD') AS date,
              count(*) FILTER (WHERE state = 'SUCCESS')::text AS succeeded,
              count(*) FILTER (WHERE state = 'FAILED')::text AS failed,
              count(*) FILTER (WHERE state = 'CANCELLED')::text AS cancelled,
              avg(duration_ms)::text AS avg_duration
       FROM workflow_runs
       WHERE organization_id = $1 AND queued_at >= $2::timestamptz AND queued_at <= $3::timestamptz${pipelineClause}
       GROUP BY 1 ORDER BY 1 ASC`,
      params,
    )).rows;

    const failures = (await this.pool.query<Record<string, string>>(
      `SELECT t.node_id, t.node_type, count(*)::text AS failures
       FROM task_runs t JOIN workflow_runs r ON r.id = t.run_id
       WHERE t.organization_id = $1 AND r.queued_at >= $2::timestamptz AND r.queued_at <= $3::timestamptz${window.pipelineId ? " AND r.pipeline_id = $4" : ""}
         AND t.state = 'FAILED'
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      params,
    )).rows;

    const quality = (await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM quality_results
       WHERE organization_id = $1 AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz AND status <> 'PASSED'`,
      [organizationId, window.from, window.to],
    )).rows[0]!;

    const succeeded = Number(totals["succeeded"]);
    const failed = Number(totals["failed"]);
    return {
      totals: {
        runs: Number(totals["runs"]),
        succeeded,
        failed,
        cancelled: Number(totals["cancelled"]),
        running: Number(totals["running"]),
      },
      successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : 0,
      averageDurationMs: totals["avg_duration"] ? Math.round(Number(totals["avg_duration"])) : null,
      p95DurationMs: totals["p95_duration"] ? Math.round(Number(totals["p95_duration"])) : null,
      series: series.map((row) => ({
        date: row["date"]!,
        succeeded: Number(row["succeeded"]),
        failed: Number(row["failed"]),
        cancelled: Number(row["cancelled"]),
        averageDurationMs: row["avg_duration"] ? Math.round(Number(row["avg_duration"])) : null,
      })),
      taskFailures: failures.map((row) => ({ nodeId: row["node_id"]!, nodeType: row["node_type"]!, failures: Number(row["failures"]) })),
      qualityFailures: Number(quality.count),
    };
  }

  async search(organizationId: string, query: string, limit = 20): Promise<SearchHit[]> {
    const needle = `%${query.trim()}%`;
    if (!query.trim()) return [];
    const rows = await this.pool.query<Record<string, string>>(
      `(SELECT 'pipeline' AS type, id, name AS title, coalesce(description,'') AS subtitle FROM pipelines
         WHERE organization_id = $1 AND (name ILIKE $2 OR coalesce(description,'') ILIKE $2) AND archived_at IS NULL LIMIT $3)
       UNION ALL
       (SELECT 'run', id, id, pipeline_name || ' · ' || state FROM workflow_runs
         WHERE organization_id = $1 AND (id ILIKE $2 OR pipeline_name ILIKE $2) ORDER BY queued_at DESC LIMIT $3)
       UNION ALL
       (SELECT 'dataset', id, name, coalesce(description,'') FROM datasets
         WHERE organization_id = $1 AND name ILIKE $2 LIMIT $3)
       UNION ALL
       (SELECT 'incident', id, title, status FROM incidents
         WHERE organization_id = $1 AND title ILIKE $2 LIMIT $3)
       UNION ALL
       (SELECT 'connection', id, name, family FROM connectors
         WHERE organization_id = $1 AND name ILIKE $2 LIMIT $3)`,
      [organizationId, needle, limit],
    );
    return rows.rows.map((row) => ({
      type: row["type"] as SearchHit["type"],
      id: row["id"]!,
      title: row["title"]!,
      ...(row["subtitle"] ? { subtitle: row["subtitle"] } : {}),
      href: hrefFor(row["type"] as SearchHit["type"], row["id"]!, row["title"]!),
      score: 1,
    })).slice(0, limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function hrefFor(type: SearchHit["type"], id: string, title: string): string {
  switch (type) {
    case "pipeline": return `/pipelines/${id}`;
    case "run": return `/runs/${id}`;
    case "dataset": return `/datasets/${encodeURIComponent(title)}`;
    case "incident": return `/incidents/${id}`;
    case "connection": return `/connectors/${id}`;
    default: return "/";
  }
}

function page<T>(items: T[], limit: number, value: (item: T) => string, id: (item: T) => string): Page<T> {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  const last = visible.at(-1);
  return {
    items: visible,
    ...(hasMore && last ? { nextCursor: encodeCursor({ value: value(last), id: id(last) }) } : {}),
  };
}

/** Maps PostgreSQL error codes onto the domain errors callers expect. */
function translate(error: unknown, conflictMessage?: string): Error {
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new ConflictError(conflictMessage ?? "That record already exists");
  if (code === "23503") return new ConflictError("Referenced record does not exist");
  return error as Error;
}

/** Creates a store backed by `pg`, which is an optional dependency. */
export async function createPostgresStore(connectionString: string, options: { max?: number; ssl?: boolean } = {}): Promise<PostgresStore> {
  const specifier = "pg";
  let pg: { Pool: new (config: Record<string, unknown>) => SqlPool };
  try {
    pg = (await import(specifier)) as never;
  } catch (error) {
    throw new Error(
      'DATABASE_URL is set but the "pg" driver is not installed. Run `pnpm add pg` in the worker and web images, or unset DATABASE_URL to use the in-memory store.',
      { cause: error },
    );
  }
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    application_name: "dataflow-studio",
  });
  return new PostgresStore(pool);
}

export type { WorkflowDefinition };
