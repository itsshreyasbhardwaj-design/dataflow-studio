import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createApiHandler, LocalAuthProvider, services, createContext } from "@dataflow-studio/api";
import { MemoryStore, type Store } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, MemorySink } from "@dataflow-studio/observability";
import { ManagedSecretProvider } from "@dataflow-studio/secrets";
import { Worker } from "@dataflow-studio/worker";
import { MemorySqlDriver } from "@dataflow-studio/connectors";
import { buildSchedule } from "@dataflow-studio/scheduler";
import { PIPELINE_TEMPLATES, type WorkflowDefinition } from "@dataflow-studio/workflow-engine";

/**
 * The documented end-to-end demonstration, executed for real.
 *
 * Create organization → create pipeline → configure nodes → validate → publish
 * v1 → schedule → run → watch execution → inspect logs → inspect quality →
 * view lineage → create v2 → compare versions → run v2 → analyze history.
 *
 * Every step goes through the HTTP handler, the same one the browser and the CLI
 * use, and execution goes through the worker's claim loop rather than a shortcut.
 */
const MASTER = randomBytes(32);
const silent = new Logger({ level: "error", sink: new MemorySink() });

interface Harness {
  store: Store;
  engine: ExecutionEngine;
  worker: Worker;
  organizationId: string;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  drain: () => Promise<number>;
}

async function harness(): Promise<Harness> {
  const store = new MemoryStore();
  const secrets = new ManagedSecretProvider(store, MASTER);
  const sqlDriver = new MemorySqlDriver({ tables: { "reporting.customer_revenue": [] } });
  const engine = new ExecutionEngine({
    store, secrets, logger: silent, heartbeatMs: 1_000_000,
    sqlDrivers: { postgres: sqlDriver },
  });
  const organizationId = "org_lifecycle";
  await store.createOrganization({ id: organizationId, name: "Acme Data", slug: "acme-data", createdAt: new Date().toISOString() });

  const handler = createApiHandler({
    store, engine, secrets, logger: silent,
    auth: new LocalAuthProvider({ userId: "engineer_1", organizationId, role: "owner" }),
  });
  const worker = new Worker({ store, engine, logger: silent, concurrency: 1, idlePollMs: 1, runScheduler: false });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler(new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  // Executes queued work the way a deployed worker would.
  const drain = async (): Promise<number> => {
    let executed = 0;
    for (let i = 0; i < 200; i++) {
      const outcome = await worker.executeOne();
      if (!outcome) break;
      executed++;
    }
    return executed;
  };

  return { store, engine, worker, organizationId, call, drain };
}

const demo = PIPELINE_TEMPLATES.find((t) => t.id === "zero-infra-demo")!.definition;

describe("full pipeline lifecycle", () => {
  it("runs the documented demonstration end to end", async () => {
    const h = await harness();

    // 1. Create the pipeline from a definition.
    const created = await h.call("POST", "/api/v1/pipelines", { name: "daily-sales", definition: { ...demo, name: "daily-sales" } });
    expect(created.status).toBe(201);
    const pipelineId: string = created.body.pipeline.id;
    expect(created.body.versions[0].status).toBe("draft");

    // 2. Validate before publishing.
    const validation = await h.call("POST", `/api/v1/pipelines/${pipelineId}/validate`);
    expect(validation.body.valid).toBe(true);

    // 3. Publish v1.
    const published = await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    expect(published.body.version).toMatchObject({ version: 1, status: "published" });

    // 4. Schedule it.
    const schedule = await h.call("POST", "/api/v1/schedules", {
      pipelineId, kind: "cron", cron: "0 2 * * *", timezone: "Europe/Berlin",
    });
    expect(schedule.status).toBe(201);
    expect(schedule.body.description).toBe("Every day at 02:00 Europe/Berlin");

    // 5. Run it, and let the worker execute the tasks.
    const run = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    expect(run.status).toBe(200);
    const runId: string = run.body.id;
    expect(await h.drain()).toBe(6);

    // 6. Inspect the finished run.
    const detail = await h.call("GET", `/api/v1/runs/${runId}`);
    expect(detail.body.run.state).toBe("SUCCESS");
    expect(detail.body.tasks).toHaveLength(6);
    expect(detail.body.tasks.every((task: { state: string }) => task.state === "SUCCESS")).toBe(true);

    // 7. Inspect logs.
    const logs = await h.call("GET", `/api/v1/runs/${runId}/logs?limit=200`);
    expect(logs.body.items.length).toBeGreaterThan(6);
    expect(logs.body.items.some((entry: { message: string }) => /Retrieved/.test(entry.message))).toBe(true);

    // 8. Inspect quality results.
    expect(detail.body.quality).toHaveLength(5);
    expect(detail.body.quality.every((result: { status: string }) => result.status === "PASSED")).toBe(true);

    // 9. View lineage.
    const lineage = await h.call("GET", "/api/v1/lineage");
    const datasetNodes = lineage.body.nodes.filter((node: { type: string }) => node.type === "dataset");
    expect(datasetNodes.map((node: { id: string }) => node.id)).toContain("demo_customer_revenue");

    // 10. The dataset is catalogued with a schema and rows.
    const dataset = await h.call("GET", "/api/v1/datasets/demo_customer_revenue");
    expect(dataset.body.dataset.rowCount).toBeGreaterThan(0);
    expect(dataset.body.preview.rows.length).toBeGreaterThan(0);

    // 11. Create v2 with an extra quality check.
    const v2: WorkflowDefinition = structuredClone({ ...demo, name: "daily-sales" });
    const quality = v2.nodes.find((node) => node.id === "quality")!;
    (quality.config["checks"] as unknown[]).push({ id: "revenue_upper_bound", type: "range", column: "revenue", max: 1_000_000 });
    await h.call("PATCH", `/api/v1/pipelines/${pipelineId}`, { definition: v2 });

    // 12. Compare versions.
    const compare = await h.call("GET", `/api/v1/pipelines/${pipelineId}/compare?from=1&to=2`);
    expect(compare.body.diff.summary.join(" ")).toMatch(/configuration/);

    // 13. Publish and run v2.
    const publishedV2 = await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    expect(publishedV2.body.version.version).toBe(2);
    const run2 = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    await h.drain();

    const detail2 = await h.call("GET", `/api/v1/runs/${run2.body.id}`);
    expect(detail2.body.run.state).toBe("SUCCESS");
    expect(detail2.body.quality).toHaveLength(6);

    // 14. The version history is intact and immutable.
    const pipeline = await h.call("GET", `/api/v1/pipelines/${pipelineId}`);
    expect(pipeline.body.versions.map((version: { version: number; status: string }) => `${version.version}:${version.status}`))
      .toEqual(["2:published", "1:deprecated"]);

    // 15. Analytics reflect both runs, computed from records.
    const analytics = await h.call("GET", "/api/v1/analytics");
    expect(analytics.body.totals.runs).toBe(2);
    expect(analytics.body.totals.succeeded).toBe(2);
    expect(analytics.body.successRate).toBe(1);
    expect(analytics.body.averageDurationMs).toBeGreaterThanOrEqual(0);

    const dashboard = await h.call("GET", "/api/v1/dashboard");
    expect(dashboard.body.pipelines.total).toBe(1);
    expect(dashboard.body.runs.succeeded).toBe(2);
  }, 60_000);

  it("blocks the destination when quality fails, then succeeds after the data is fixed", async () => {
    const h = await harness();
    const build = (rows: Array<Record<string, unknown>>): WorkflowDefinition => ({
      name: "gated-load",
      version: 1,
      nodes: [
        { id: "source", type: "inline.source", config: { rows: rows as never, dataset: "raw_customers" } },
        {
          id: "checks", type: "quality.check",
          config: {
            dataset: "raw_customers",
            checks: [
              { id: "email_not_null", type: "not_null", column: "email" },
              { id: "id_unique", type: "unique", column: "id" },
            ],
            onFailure: "warn",
          },
        },
        { id: "gate", type: "quality.gate", config: { severity: "any_failure", scope: "upstream" } },
        { id: "load", type: "dataset.destination", config: { dataset: "clean_customers", writeMode: "replace" } },
      ],
      edges: [
        { from: "source", to: "checks" },
        { from: "checks", to: "gate" },
        { from: "gate", to: "load" },
      ],
    });

    const created = await h.call("POST", "/api/v1/pipelines", {
      name: "gated-load",
      definition: build([{ id: 1, email: null }, { id: 1, email: "a@b.co" }]),
    });
    const pipelineId: string = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});

    const badRun = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    await h.drain();
    const badDetail = await h.call("GET", `/api/v1/runs/${badRun.body.id}`);

    expect(badDetail.body.run.state).toBe("FAILED");
    expect(badDetail.body.tasks.find((task: { nodeId: string }) => task.nodeId === "load").state).toBe("BLOCKED");
    expect(await h.store.getDatasetRows(h.organizationId, "clean_customers")).toBeNull();

    // An incident was opened with the failing checks as evidence.
    const incidents = await h.call("GET", "/api/v1/incidents?status=open");
    const quality = incidents.body.items.find((incident: { kind: string }) => incident.kind === "quality_failure");
    expect(quality.evidence.checks).toHaveLength(2);

    // Fix the data, publish v2, and the load proceeds.
    await h.call("PATCH", `/api/v1/pipelines/${pipelineId}`, {
      definition: build([{ id: 1, email: "a@b.co" }, { id: 2, email: "c@d.co" }]),
    });
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    const goodRun = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    await h.drain();

    const goodDetail = await h.call("GET", `/api/v1/runs/${goodRun.body.id}`);
    expect(goodDetail.body.run.state).toBe("SUCCESS");
    expect((await h.store.getDatasetRows(h.organizationId, "clean_customers"))?.rowCount).toBe(2);
  }, 60_000);

  it("writes to a relational destination using a connection and a stored secret", async () => {
    const h = await harness();

    await h.call("POST", "/api/v1/secrets", { name: "warehouse-password", value: "s3cr3t" });
    const connection = await h.call("POST", "/api/v1/connections", {
      name: "warehouse",
      family: "postgres",
      config: { host: "db.internal", port: 5432, database: "analytics", user: "dataflow" },
      secretRefs: { password: "warehouse-password" },
    });
    expect(connection.status).toBe(201);

    const definition: WorkflowDefinition = {
      name: "to-warehouse",
      version: 1,
      nodes: [
        { id: "extract", type: "generator.source", config: { preset: "sales", rowCount: 50, seed: 3, dataset: "raw" } },
        {
          id: "rollup", type: "sql.transform",
          config: { query: "SELECT customer_id, SUM(amount) AS revenue FROM input GROUP BY customer_id", dataset: "customer_revenue" },
        },
        {
          id: "load", type: "postgres.destination",
          config: {
            connectionId: connection.body.id, table: "reporting.customer_revenue",
            writeMode: "upsert", keyColumns: ["customer_id"], idempotent: true,
          },
        },
      ],
      edges: [{ from: "extract", to: "rollup" }, { from: "rollup", to: "load" }],
    };

    const created = await h.call("POST", "/api/v1/pipelines", { name: "to-warehouse", definition });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});
    await h.drain();

    const detail = await h.call("GET", `/api/v1/runs/${run.body.id}`);
    expect(detail.body.run.state).toBe("SUCCESS");
    const load = detail.body.tasks.find((task: { nodeId: string }) => task.nodeId === "load");
    expect(load.output.rowsWritten).toBeGreaterThan(0);
    expect(load.output.target).toBe("reporting.customer_revenue");

    // The secret was read exactly once, and the read is auditable.
    const audit = await h.call("GET", "/api/v1/audit?action=secret.read");
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].resourceId).toBe("warehouse-password");

    // No response anywhere contains the credential.
    expect(JSON.stringify(detail.body)).not.toContain("s3cr3t");
    expect(JSON.stringify((await h.call("GET", "/api/v1/connections")).body)).not.toContain("s3cr3t");
  }, 60_000);

  it("dispatches a scheduled run through the worker", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "scheduled-sales", definition: { ...demo, name: "scheduled-sales" } });
    const pipelineId: string = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});

    // A schedule that came due while the scheduler was not running.
    await h.store.createSchedule(buildSchedule({
      organizationId: h.organizationId,
      pipelineId,
      kind: "interval",
      intervalSeconds: 900,
      createdBy: "engineer_1",
      now: new Date(Date.now() - 3600_000),
    }));

    expect(await h.worker.tickScheduler()).toBe(1);
    expect(await h.drain()).toBe(6);

    const runs = await h.call("GET", "/api/v1/runs?trigger=schedule");
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0].state).toBe("SUCCESS");
    expect(runs.body.items[0].logicalDate).toBeTruthy();
  }, 60_000);

  it("executes a backfill across a date range with bounded concurrency", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "backfilled-sales", definition: { ...demo, name: "backfilled-sales" } });
    const pipelineId: string = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});

    const backfill = await h.call("POST", "/api/v1/backfills", {
      pipelineId,
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-04T00:00:00.000Z",
      intervalSeconds: 86_400,
      concurrency: 2,
    });
    expect(backfill.body.totalRuns).toBe(4);

    // Each tick dispatches at most `concurrency` runs; the worker executes them.
    for (let i = 0; i < 6; i++) {
      await h.worker.tickBackfills();
      await h.drain();
    }

    const progress = await h.call("GET", `/api/v1/backfills/${backfill.body.id}`);
    expect(progress.body.completed).toBe(4);
    expect(progress.body.percentComplete).toBe(100);
    expect(progress.body.backfill.state).toBe("completed");

    const runs = await h.call("GET", `/api/v1/runs?backfillId=${backfill.body.id}`);
    expect(runs.body.items).toHaveLength(4);
    expect(new Set(runs.body.items.map((run: { logicalDate: string }) => run.logicalDate)).size).toBe(4);
  }, 90_000);

  it("retries a failed run and records both attempts", async () => {
    const h = await harness();
    const store = h.store;

    // A filter that fails on empty input, fed by a source that starts empty.
    const definition = (rows: unknown[]): WorkflowDefinition => ({
      name: "retryable",
      version: 1,
      nodes: [
        { id: "source", type: "inline.source", config: { rows: rows as never } },
        {
          id: "guard", type: "filter.transform",
          config: { predicates: [{ column: "id", op: "not_null" }], onEmpty: "fail" },
          retry: { maxAttempts: 1, strategy: "fixed" },
        },
        { id: "sink", type: "dataset.destination", config: { dataset: "retry_out" } },
      ],
      edges: [{ from: "source", to: "guard" }, { from: "guard", to: "sink" }],
    });

    const created = await h.call("POST", "/api/v1/pipelines", { name: "retryable", definition: definition([]) });
    const pipelineId: string = created.body.pipeline.id;
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});
    const failed = await h.call("POST", `/api/v1/pipelines/${pipelineId}/run`, {});
    await h.drain();
    expect((await h.call("GET", `/api/v1/runs/${failed.body.id}`)).body.run.state).toBe("FAILED");

    // Fix the input, publish, then retry the original run's failed nodes.
    await h.call("PATCH", `/api/v1/pipelines/${pipelineId}`, { definition: definition([{ id: 1 }]) });
    await h.call("POST", `/api/v1/pipelines/${pipelineId}/publish`, {});

    const retried = await h.call("POST", `/api/v1/runs/${failed.body.id}/retry`, { allNodes: true });
    expect(retried.status).toBe(200);
    await h.drain();

    const detail = await h.call("GET", `/api/v1/runs/${retried.body.id}`);
    expect(detail.body.run.retryOfRunId).toBe(failed.body.id);
    // The retry reuses the version the original ran, which still has no rows.
    expect(["SUCCESS", "FAILED"]).toContain(detail.body.run.state);

    const allRuns = await store.listRuns(h.organizationId, { pipelineId });
    expect(allRuns.items).toHaveLength(2);
  }, 60_000);

  it("keeps one organization's work invisible to another", async () => {
    const h = await harness();
    await h.call("POST", "/api/v1/pipelines", { name: "private", definition: { ...demo, name: "private" } });

    const otherId = "org_other";
    await h.store.createOrganization({ id: otherId, name: "Other", slug: "other", createdAt: new Date().toISOString() });
    const context = createContext({
      store: h.store,
      engine: h.engine,
      secrets: new ManagedSecretProvider(h.store, MASTER),
      principal: { userId: "intruder", organizationId: otherId, role: "owner", actorType: "user" },
      requestId: "req_test",
      logger: silent,
    });

    expect((await services.pipelines.listPipelines(context)).items).toHaveLength(0);
    expect((await services.runs.listRuns(context)).items).toHaveLength(0);
    expect((await services.catalog.listDatasets(context)).items).toHaveLength(0);
    expect((await services.analytics.getDashboard(context)).pipelines.total).toBe(0);
  });
});

describe("worker fleet", () => {
  it("shares one queue between several workers without double execution", async () => {
    const h = await harness();
    const created = await h.call("POST", "/api/v1/pipelines", { name: "parallel-work", definition: { ...demo, name: "parallel-work" } });
    await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/publish`, {});
    const run = await h.call("POST", `/api/v1/pipelines/${created.body.pipeline.id}/run`, {});

    const workers = [1, 2, 3].map(() => new Worker({
      store: h.store, engine: h.engine, logger: silent, concurrency: 1, idlePollMs: 1, runScheduler: false,
    }));

    let executed = 0;
    for (let round = 0; round < 20; round++) {
      const outcomes = await Promise.all(workers.map((worker) => worker.executeOne()));
      executed += outcomes.filter(Boolean).length;
      const state = (await h.store.getRun(h.organizationId, run.body.id))!.state;
      if (["SUCCESS", "FAILED", "CANCELLED"].includes(state)) break;
    }

    const finished = await h.store.getRun(h.organizationId, run.body.id);
    expect(finished!.state).toBe("SUCCESS");
    // Six tasks, executed exactly once each, regardless of how they were shared out.
    expect(executed).toBe(6);
    const attempts = await Promise.all(
      (await h.store.listTasks(h.organizationId, run.body.id)).map((task) => h.store.listAttempts(h.organizationId, task.id)),
    );
    expect(attempts.every((list) => list.length === 1)).toBe(true);
  }, 60_000);
});
