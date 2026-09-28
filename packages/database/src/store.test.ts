import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@dataflow-studio/observability";
import { MemoryStore } from "./memory-store.js";
import { createPostgresStore, type PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";
import type { Pipeline, PipelineVersion, TaskRun, WorkflowRun } from "./types.js";

/**
 * One conformance suite, two drivers. The in-memory driver always runs; the
 * PostgreSQL driver runs whenever TEST_DATABASE_URL is set, which is how CI
 * exercises the real SQL (see .github/workflows/ci.yml).
 */
const drivers: Array<{ name: string; create: () => Promise<Store> }> = [
  { name: "memory", create: async () => new MemoryStore() },
];

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (testDatabaseUrl) {
  drivers.push({
    name: "postgres",
    create: async () => {
      const store = await createPostgresStore(testDatabaseUrl);
      await store.migrate();
      return store;
    },
  });
}

const opened: Store[] = [];
afterAll(async () => {
  for (const store of opened) await store.close?.();
});

const definition = (name: string) => ({
  name,
  version: 1,
  nodes: [
    { id: "extract", type: "generator.source", config: { preset: "sales", rowCount: 10 } },
    { id: "load", type: "dataset.destination", config: { dataset: "out" } },
  ],
  edges: [{ from: "extract", to: "load" }],
});

for (const driver of drivers) {
  describe(`Store conformance (${driver.name})`, () => {
    const setup = async () => {
      const store = await driver.create();
      opened.push(store);
      const organizationId = newId("org");
      await store.createOrganization({
        id: organizationId, name: "Acme", slug: `acme-${organizationId.slice(-8)}`, createdAt: new Date().toISOString(),
      });
      await store.upsertMember({ organizationId, userId: "user_1", role: "owner", createdAt: new Date().toISOString() });
      return { store, organizationId };
    };

    const seedPipeline = async (store: Store, organizationId: string, name = `pipe-${Date.now().toString(36)}`) => {
      const now = new Date().toISOString();
      const pipeline: Pipeline = {
        id: newId("pipe"), organizationId, name, publishedVersionId: null, latestVersionNumber: 1,
        createdBy: "user_1", createdAt: now, updatedAt: now, tags: ["etl"],
      };
      await store.createPipeline(pipeline);
      const version: PipelineVersion = {
        id: newId("ver"), organizationId, pipelineId: pipeline.id, version: 1, status: "draft",
        definition: definition(name) as never, definitionHash: "hash1", createdBy: "user_1", createdAt: now,
      };
      await store.createVersion(version);
      return { pipeline, version };
    };

    it("creates and reads an organization and its members", async () => {
      const { store, organizationId } = await setup();
      expect(await store.getOrganization(organizationId)).toMatchObject({ name: "Acme" });
      expect(await store.getMember(organizationId, "user_1")).toMatchObject({ role: "owner" });
      expect(await store.listOrganizationsForUser("user_1")).toHaveLength(1);
      expect(await store.listOrganizationsForUser("stranger")).toHaveLength(0);
    });

    it("rejects a duplicate pipeline name within a tenant", async () => {
      const { store, organizationId } = await setup();
      const { pipeline } = await seedPipeline(store, organizationId, "daily-sales");
      await expect(
        store.createPipeline({ ...pipeline, id: newId("pipe") }),
      ).rejects.toThrow(/already exists/);
    });

    it("isolates tenants", async () => {
      const { store, organizationId } = await setup();
      const { pipeline } = await seedPipeline(store, organizationId);
      const other = newId("org");
      await store.createOrganization({ id: other, name: "Other", slug: `other-${other.slice(-8)}`, createdAt: new Date().toISOString() });
      expect(await store.getPipeline(other, pipeline.id)).toBeNull();
      expect((await store.listPipelines(other)).items).toHaveLength(0);
    });

    it("publishes a version and deprecates the previous one", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const at = new Date().toISOString();
      await store.publishVersion(organizationId, pipeline.id, version.id, at);

      const v2: PipelineVersion = { ...version, id: newId("ver"), version: 2, status: "draft", definitionHash: "hash2" };
      await store.createVersion(v2);
      await store.publishVersion(organizationId, pipeline.id, v2.id, at);

      const versions = await store.listVersions(organizationId, pipeline.id);
      expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(["2:published", "1:deprecated"]);
      expect((await store.getPipeline(organizationId, pipeline.id))?.publishedVersionId).toBe(v2.id);
    });

    it("stores a run with its tasks and reads them back", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date().toISOString();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "QUEUED", trigger: "manual", triggeredBy: "user_1",
        queuedAt: now, params: { region: "north" },
      };
      const tasks: TaskRun[] = [
        { id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "extract", nodeType: "generator.source", state: "QUEUED", attempt: 0, maxAttempts: 3, scheduledAt: now, dependsOn: [], priority: 0 },
        { id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "load", nodeType: "dataset.destination", state: "PENDING", attempt: 0, maxAttempts: 1, scheduledAt: now, dependsOn: ["extract"], priority: 0 },
      ];
      await store.createRun(run, tasks);

      expect(await store.getRun(organizationId, run.id)).toMatchObject({ state: "QUEUED", params: { region: "north" } });
      const stored = await store.listTasks(organizationId, run.id);
      expect(stored.map((t) => t.nodeId)).toEqual(["extract", "load"]);
      expect(stored.find((t) => t.nodeId === "load")?.dependsOn).toEqual(["extract"]);
    });

    it("claims a task exactly once and reclaims an expired lease", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "RUNNING", trigger: "manual", triggeredBy: "user_1",
        queuedAt: now.toISOString(),
      };
      const task: TaskRun = {
        id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "extract",
        nodeType: "generator.source", state: "QUEUED", attempt: 0, maxAttempts: 3,
        scheduledAt: now.toISOString(), dependsOn: [], priority: 0,
      };
      await store.createRun(run, [task]);

      const claimed = await store.claimNextTask({ workerId: "worker-a", leaseSeconds: 60, now });
      expect(claimed?.id).toBe(task.id);
      expect(claimed?.state).toBe("RUNNING");
      expect(claimed?.workerId).toBe("worker-a");

      // A second worker must not get the same task.
      expect(await store.claimNextTask({ workerId: "worker-b", leaseSeconds: 60, now })).toBeNull();

      // Extend then expire the lease.
      expect(await store.extendLease(organizationId, task.id, "worker-a", 60)).toBe(true);
      expect(await store.extendLease(organizationId, task.id, "worker-b", 60)).toBe(false);

      const later = new Date(now.getTime() + 10 * 60_000);
      const reclaimed = await store.reclaimExpiredLeases(later);
      expect(reclaimed.map((t) => t.id)).toContain(task.id);
      expect((await store.getTask(organizationId, task.id))?.state).toBe("QUEUED");

      const reclaimedByOther = await store.claimNextTask({ workerId: "worker-b", leaseSeconds: 60, now: later });
      expect(reclaimedByOther?.workerId).toBe("worker-b");
    });

    it("honours node-type filtering when claiming", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "RUNNING", trigger: "manual", triggeredBy: "u", queuedAt: now.toISOString(),
      };
      await store.createRun(run, [{
        id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "n",
        nodeType: "python.transform", state: "QUEUED", attempt: 0, maxAttempts: 1, scheduledAt: now.toISOString(), dependsOn: [], priority: 0,
      }]);
      expect(await store.claimNextTask({ workerId: "w", leaseSeconds: 30, now, nodeTypes: ["sql.transform"] })).toBeNull();
      expect(await store.claimNextTask({ workerId: "w", leaseSeconds: 30, now, nodeTypes: ["python.transform"] })).not.toBeNull();
    });

    it("compare-and-set rejects a stale transition", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date().toISOString();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "RUNNING", trigger: "manual", triggeredBy: "u", queuedAt: now,
      };
      const task: TaskRun = {
        id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "n", nodeType: "t",
        state: "RUNNING", attempt: 1, maxAttempts: 1, scheduledAt: now, dependsOn: [], priority: 0,
      };
      await store.createRun(run, [task]);
      expect(await store.compareAndSetTaskState(organizationId, task.id, "RUNNING", { state: "SUCCESS" })).not.toBeNull();
      expect(await store.compareAndSetTaskState(organizationId, task.id, "RUNNING", { state: "FAILED" })).toBeNull();
      expect((await store.getTask(organizationId, task.id))?.state).toBe("SUCCESS");
    });

    it("appends and filters logs", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "RUNNING", trigger: "manual", triggeredBy: "u", queuedAt: now.toISOString(),
      };
      const task: TaskRun = {
        id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "n", nodeType: "t",
        state: "RUNNING", attempt: 1, maxAttempts: 1, scheduledAt: now.toISOString(), dependsOn: [], priority: 0,
      };
      await store.createRun(run, [task]);
      await store.appendLogs([
        { id: newId("evt"), organizationId, runId: run.id, taskRunId: task.id, attempt: 1, timestamp: new Date(now.getTime()).toISOString(), level: "info", message: "Connecting to PostgreSQL" },
        { id: newId("evt"), organizationId, runId: run.id, taskRunId: task.id, attempt: 1, timestamp: new Date(now.getTime() + 1000).toISOString(), level: "warn", message: "312 rows contain null customer_id" },
      ]);
      const all = await store.listLogs(organizationId, run.id);
      expect(all.items).toHaveLength(2);
      expect(all.items[0]!.message).toContain("Connecting");
      expect((await store.listLogs(organizationId, run.id, { level: "warn" })).items).toHaveLength(1);
      expect((await store.listLogs(organizationId, run.id, { search: "null customer" })).items).toHaveLength(1);
    });

    it("assigns monotonic run event sequences", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "QUEUED", trigger: "manual", triggeredBy: "u",
        queuedAt: new Date().toISOString(),
      };
      await store.createRun(run, []);
      const first = await store.appendRunEvent({ organizationId, runId: run.id, type: "run.queued", payload: {} });
      const second = await store.appendRunEvent({ organizationId, runId: run.id, type: "run.started", payload: {} });
      expect(second.sequence).toBeGreaterThan(first.sequence);
      expect(await store.listRunEvents(organizationId, run.id, first.sequence)).toHaveLength(1);
    });

    it("paginates runs with a stable cursor", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const base = Date.now();
      for (let i = 0; i < 7; i++) {
        await store.createRun({
          id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
          pipelineName: pipeline.name, version: 1, state: "SUCCESS", trigger: "manual", triggeredBy: "u",
          queuedAt: new Date(base + i * 1000).toISOString(),
        }, []);
      }
      const first = await store.listRuns(organizationId, { limit: 3 });
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).toBeDefined();
      const second = await store.listRuns(organizationId, { limit: 3, cursor: first.nextCursor });
      expect(second.items).toHaveLength(3);
      expect(second.items.map((r) => r.id)).not.toEqual(first.items.map((r) => r.id));
      const third = await store.listRuns(organizationId, { limit: 3, cursor: second.nextCursor });
      expect(third.items).toHaveLength(1);
      expect(third.nextCursor).toBeUndefined();
    });

    it("filters runs by state and pipeline", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = Date.now();
      for (const [i, state] of (["SUCCESS", "FAILED", "RUNNING"] as const).entries()) {
        await store.createRun({
          id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
          pipelineName: pipeline.name, version: 1, state, trigger: "manual", triggeredBy: "u",
          queuedAt: new Date(now + i).toISOString(),
        }, []);
      }
      expect((await store.listRuns(organizationId, { state: "FAILED" })).items).toHaveLength(1);
      expect((await store.listRuns(organizationId, { state: ["SUCCESS", "FAILED"] })).items).toHaveLength(2);
      expect((await store.listRuns(organizationId, { pipelineId: "nope" })).items).toHaveLength(0);
      expect(await store.countRunsByState(organizationId)).toMatchObject({ SUCCESS: 1, FAILED: 1, RUNNING: 1 });
    });

    it("returns the latest run per pipeline in one query", async () => {
      const { store, organizationId } = await setup();
      const a = await seedPipeline(store, organizationId, `a-${Date.now().toString(36)}`);
      const b = await seedPipeline(store, organizationId, `b-${Date.now().toString(36)}`);
      const base = Date.now();
      for (const [i, seed] of [a, a, b].entries()) {
        await store.createRun({
          id: newId("run"), organizationId, pipelineId: seed.pipeline.id, pipelineVersionId: seed.version.id,
          pipelineName: seed.pipeline.name, version: 1, state: "SUCCESS", trigger: "manual", triggeredBy: "u",
          queuedAt: new Date(base + i * 1000).toISOString(),
        }, []);
      }
      const latest = await store.latestRunPerPipeline(organizationId, [a.pipeline.id, b.pipeline.id]);
      expect(Object.keys(latest).sort()).toEqual([a.pipeline.id, b.pipeline.id].sort());
    });

    it("stores schedules and claims the due ones", async () => {
      const { store, organizationId } = await setup();
      const { pipeline } = await seedPipeline(store, organizationId);
      const now = new Date();
      await store.createSchedule({
        id: newId("sch"), organizationId, pipelineId: pipeline.id, kind: "cron", cron: "0 2 * * *",
        timezone: "Europe/Berlin", enabled: true, catchup: false,
        nextRunAt: new Date(now.getTime() - 1000).toISOString(),
        createdBy: "u", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      await store.createSchedule({
        id: newId("sch"), organizationId, pipelineId: pipeline.id, kind: "interval", intervalSeconds: 900,
        timezone: "UTC", enabled: false, catchup: false,
        nextRunAt: new Date(now.getTime() - 1000).toISOString(),
        createdBy: "u", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      expect(await store.listSchedules(organizationId)).toHaveLength(2);
      const due = await store.claimDueSchedules(now);
      expect(due).toHaveLength(1);
      expect(due[0]!.timezone).toBe("Europe/Berlin");
    });

    it("tracks backfill progress", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date().toISOString();
      const backfill = await store.createBackfill({
        id: newId("bfl"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z", intervalSeconds: 86_400,
        concurrency: 2, state: "pending", totalRuns: 3, completedRuns: 0, failedRuns: 0,
        pendingDates: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
        createdBy: "u", createdAt: now, updatedAt: now,
      });
      expect(backfill.from).toBe("2026-01-01T00:00:00.000Z");
      expect(backfill.pendingDates).toHaveLength(3);
      const updated = await store.updateBackfill(organizationId, backfill.id, { state: "running", completedRuns: 1, pendingDates: ["2026-01-03T00:00:00.000Z"] });
      expect(updated).toMatchObject({ state: "running", completedRuns: 1 });
      expect(updated.pendingDates).toEqual(["2026-01-03T00:00:00.000Z"]);
      expect(await store.listActiveBackfills()).not.toHaveLength(0);
    });

    it("stores connections and rejects duplicates", async () => {
      const { store, organizationId } = await setup();
      const now = new Date().toISOString();
      const connection = await store.createConnection({
        id: newId("conn"), organizationId, name: "prod-postgres", family: "postgres",
        config: { host: "db.internal", port: 5432 }, secretRefs: { password: "prod-pg-password" },
        createdBy: "u", createdAt: now, updatedAt: now,
      });
      expect(connection.config).toMatchObject({ host: "db.internal" });
      expect(await store.listConnections(organizationId)).toHaveLength(1);
      await expect(store.createConnection({ ...connection, id: newId("conn") })).rejects.toThrow(/already exists/);
      expect(await store.deleteConnection(organizationId, connection.id)).toBe(true);
    });

    it("round-trips secret records without exposing plaintext", async () => {
      const { store, organizationId } = await setup();
      const now = new Date().toISOString();
      await store.upsertSecret({
        organizationId, name: "prod-pg-password", backend: "managed",
        ciphertext: "v1:aaa:bbb:ccc", fingerprint: "abc123", createdAt: now, updatedAt: now,
      });
      const stored = await store.getSecret(organizationId, "prod-pg-password");
      expect(stored?.ciphertext).toBe("v1:aaa:bbb:ccc");
      await store.touchSecret(organizationId, "prod-pg-password", now);
      expect((await store.listSecrets(organizationId))).toHaveLength(1);
      expect(await store.deleteSecret(organizationId, "prod-pg-password")).toBe(true);
    });

    it("writes and reads managed datasets", async () => {
      const { store, organizationId } = await setup();
      await store.putDataset(organizationId, "demo_revenue", {
        rows: [{ customer_id: "c1", revenue: 100 }],
        columns: [{ name: "customer_id", type: "string", nullable: false }, { name: "revenue", type: "integer", nullable: false }],
        rowCount: 1, writeMode: "replace",
      });
      expect((await store.getDatasetRows(organizationId, "demo_revenue"))?.rowCount).toBe(1);
      await store.putDataset(organizationId, "demo_revenue", {
        rows: [{ customer_id: "c2", revenue: 50 }], columns: [], rowCount: 1, writeMode: "append",
      });
      expect((await store.getDatasetRows(organizationId, "demo_revenue"))?.rowCount).toBe(2);
      expect((await store.listDatasets(organizationId)).items.map((d) => d.name)).toContain("demo_revenue");
    });

    it("versions dataset schemas", async () => {
      const { store, organizationId } = await setup();
      await store.insertSchema(organizationId, {
        dataset: "customers", version: 1, fingerprint: "f1", createdAt: new Date().toISOString(),
        columns: [{ name: "id", type: "integer", nullable: false }],
      });
      await store.insertSchema(organizationId, {
        dataset: "customers", version: 2, fingerprint: "f2", createdAt: new Date().toISOString(),
        columns: [{ name: "id", type: "integer", nullable: false }, { name: "country", type: "string", nullable: true }],
      });
      expect((await store.latestSchema(organizationId, "customers"))?.version).toBe(2);
      expect(await store.listSchemaVersions(organizationId, "customers")).toHaveLength(2);
      expect((await store.getDataset(organizationId, "customers"))?.latestSchemaVersion).toBe(2);
    });

    it("stores quality results and filters them", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const now = new Date().toISOString();
      const run: WorkflowRun = {
        id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        pipelineName: pipeline.name, version: 1, state: "SUCCESS", trigger: "manual", triggeredBy: "u", queuedAt: now,
      };
      const task: TaskRun = {
        id: newId("task"), organizationId, runId: run.id, pipelineId: pipeline.id, nodeId: "q", nodeType: "quality.check",
        state: "SUCCESS", attempt: 1, maxAttempts: 1, scheduledAt: now, dependsOn: [], priority: 0,
      };
      await store.createRun(run, [task]);
      await store.insertQualityResults([{
        id: newId("qr"), organizationId, runId: run.id, taskRunId: task.id, pipelineId: pipeline.id,
        dataset: "customers", checkId: "customer_id_not_null", checkType: "not_null", column: "customer_id",
        status: "FAILED", severity: "error", expected: "NOT NULL, expected 100%", actual: "99.4%",
        passedRows: 994, failedRows: 6, totalRows: 1000, passRate: 0.994, message: "6/1000 rows failed", createdAt: now,
      }]);
      const results = await store.listQualityResults(organizationId, { runId: run.id });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ column: "customer_id", status: "FAILED", actual: "99.4%" });
      expect(await store.listQualityResults(organizationId, { dataset: "nope" })).toHaveLength(0);
    });

    it("replaces lineage per version", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const edge = {
        id: newId("lin"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
        fromType: "dataset" as const, fromId: "raw_sales", toType: "node" as const, toId: "transform",
        observedAt: new Date().toISOString(),
      };
      await store.replaceLineage(organizationId, version.id, [edge]);
      expect(await store.listLineage(organizationId, { pipelineId: pipeline.id })).toHaveLength(1);
      await store.replaceLineage(organizationId, version.id, []);
      expect(await store.listLineage(organizationId, { pipelineId: pipeline.id })).toHaveLength(0);
    });

    it("deduplicates incidents by fingerprint", async () => {
      const { store, organizationId } = await setup();
      const now = new Date().toISOString();
      const incident = {
        id: newId("inc"), organizationId, kind: "repeated_failure" as const, severity: "high" as const,
        title: "daily-sales failed 3 times", evidence: { runs: 3 }, status: "open" as const,
        fingerprint: "repeated_failure:daily-sales", occurrences: 1, firstSeenAt: now, lastSeenAt: now,
      };
      await store.upsertIncident(incident);
      const existing = await store.getIncidentByFingerprint(organizationId, incident.fingerprint);
      expect(existing?.occurrences).toBe(1);
      await store.upsertIncident({ ...incident, occurrences: 2, lastSeenAt: new Date(Date.now() + 1000).toISOString() });
      expect((await store.listIncidents(organizationId, { status: "open" })).items).toHaveLength(1);
      expect((await store.getIncidentByFingerprint(organizationId, incident.fingerprint))?.occurrences).toBe(2);
      await store.updateIncident(organizationId, incident.id, { status: "resolved", resolvedAt: now });
      expect(await store.getIncidentByFingerprint(organizationId, incident.fingerprint)).toBeNull();
    });

    it("appends audit entries and filters them", async () => {
      const { store, organizationId } = await setup();
      const now = new Date().toISOString();
      await store.appendAudit({
        id: newId("audit"), organizationId, actor: "user_1", actorType: "user", action: "pipeline.publish",
        resourceType: "pipeline", resourceId: "pipe_1", result: "success", requestId: "req_1", createdAt: now,
      });
      await store.appendAudit({
        id: newId("audit"), organizationId, actor: "user_2", actorType: "user", action: "secret.read",
        resourceType: "secret", result: "denied", createdAt: new Date(Date.now() + 1000).toISOString(),
      });
      expect((await store.listAudit(organizationId)).items).toHaveLength(2);
      expect((await store.listAudit(organizationId, { action: "pipeline.publish" })).items).toHaveLength(1);
      expect((await store.listAudit(organizationId, { actor: "user_2" })).items[0]).toMatchObject({ result: "denied" });
    });

    it("stores API keys by hash and revokes them", async () => {
      const { store, organizationId } = await setup();
      const now = new Date().toISOString();
      const key = await store.createApiKey({
        id: newId("key"), organizationId, name: "ci", tokenHash: `hash-${organizationId}`, prefix: "dfs_live_abc",
        role: "developer", createdBy: "u", createdAt: now,
      });
      expect(await store.getApiKeyByHash(key.tokenHash)).toMatchObject({ name: "ci", role: "developer" });
      await store.touchApiKey(key.id, now);
      expect(await store.revokeApiKey(organizationId, key.id, now)).toBe(true);
      expect((await store.getApiKeyByHash(key.tokenHash))?.revokedAt).toBeTruthy();
      expect(await store.revokeApiKey("org_other", key.id, now)).toBe(false);
    });

    it("stores uploaded files", async () => {
      const { store, organizationId } = await setup();
      const file = {
        id: newId("evt"), organizationId, filename: "sales.csv", contentType: "text/csv",
        bytes: 12, createdBy: "u", createdAt: new Date().toISOString(),
      };
      await store.putFile(file, Buffer.from("id,amount\n1,2\n"));
      const loaded = await store.getFile(organizationId, file.id);
      expect(loaded?.content.toString()).toContain("id,amount");
      expect(await store.getFile("org_other", file.id)).toBeNull();
      expect(await store.listFiles(organizationId)).toHaveLength(1);
    });

    it("computes run analytics from real records", async () => {
      const { store, organizationId } = await setup();
      const { pipeline, version } = await seedPipeline(store, organizationId);
      const day = "2026-03-30T10:00:00.000Z";
      const nextDay = "2026-03-31T10:00:00.000Z";
      for (const [queuedAt, state, durationMs] of [
        [day, "SUCCESS", 1000], [day, "SUCCESS", 3000], [day, "FAILED", 2000], [nextDay, "SUCCESS", 5000],
      ] as const) {
        await store.createRun({
          id: newId("run"), organizationId, pipelineId: pipeline.id, pipelineVersionId: version.id,
          pipelineName: pipeline.name, version: 1, state, trigger: "schedule", triggeredBy: "system",
          queuedAt, finishedAt: queuedAt, durationMs,
        }, []);
      }
      const analytics = await store.runAnalytics(organizationId, { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" });
      expect(analytics.totals).toMatchObject({ runs: 4, succeeded: 3, failed: 1 });
      expect(analytics.successRate).toBeCloseTo(0.75, 5);
      expect(analytics.averageDurationMs).toBe(2750);
      expect(analytics.series.map((s) => s.date)).toEqual(["2026-03-30", "2026-03-31"]);
      expect(analytics.series[0]).toMatchObject({ succeeded: 2, failed: 1, averageDurationMs: 2000 });
    });

    it("searches across entities", async () => {
      const { store, organizationId } = await setup();
      await seedPipeline(store, organizationId, "daily-sales-search");
      await store.putDataset(organizationId, "daily_sales_dataset", { rows: [], columns: [], rowCount: 0, writeMode: "replace" });
      const hits = await store.search(organizationId, "daily");
      expect(hits.some((h) => h.type === "pipeline")).toBe(true);
      expect(hits.some((h) => h.type === "dataset")).toBe(true);
      expect(await store.search(organizationId, "")).toEqual([]);
      expect(await store.search("org_other", "daily")).toEqual([]);
    });
  });
}
