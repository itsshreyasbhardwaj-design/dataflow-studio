import { describe, expect, it } from "vitest";
import { MemoryStore, type Store } from "@dataflow-studio/database";
import { EnvironmentSecretProvider } from "@dataflow-studio/secrets";
import { Logger, MemorySink, newId } from "@dataflow-studio/observability";
import { PIPELINE_TEMPLATES, validateWorkflow, type WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import { MemorySqlDriver } from "@dataflow-studio/connectors";
import { ExecutionEngine } from "./engine.js";
import { planRun } from "./planner.js";
import { DisabledPythonSandbox, SubprocessPythonSandbox } from "./sandbox.js";
import { registerExecutor, executorFor } from "./executors.js";
import { gatherFailureEvidence } from "./investigate.js";
import { detectIncidents, detectStaleDatasets } from "./incidents.js";

const ORG = "org_test";
const silent = new Logger({ level: "error", sink: new MemorySink() });

async function setup(options: { sqlDriver?: MemorySqlDriver } = {}) {
  const store: Store = new MemoryStore();
  await store.createOrganization({ id: ORG, name: "Test", slug: "test", createdAt: new Date().toISOString() });
  const engine = new ExecutionEngine({
    store,
    secrets: new EnvironmentSecretProvider({ DATAFLOW_SECRET_API_TOKEN: "token-value" }),
    logger: silent,
    leaseSeconds: 60,
    heartbeatMs: 1_000_000, // no heartbeat noise in tests unless a test wants it
    ...(options.sqlDriver ? { sqlDrivers: { postgres: options.sqlDriver } } : {}),
  });
  return { store, engine };
}

async function publish(store: Store, definition: WorkflowDefinition) {
  const now = new Date().toISOString();
  const existing = await store.getPipelineByName(ORG, definition.name);
  const pipelineId = existing?.id ?? newId("pipe");
  const versionId = newId("ver");
  if (existing) {
    await store.updatePipeline(ORG, pipelineId, { publishedVersionId: versionId, latestVersionNumber: (existing.latestVersionNumber ?? 1) + 1, updatedAt: now });
  } else {
    await store.createPipeline({
      id: pipelineId, organizationId: ORG, name: definition.name, publishedVersionId: versionId,
      latestVersionNumber: definition.version, createdBy: "user_1", createdAt: now, updatedAt: now,
    });
  }
  await store.createVersion({
    id: versionId, organizationId: ORG, pipelineId, version: definition.version, status: "published",
    definition, definitionHash: `hash-${versionId}`, createdBy: "user_1", createdAt: now, publishedAt: now,
  });
  return { pipelineId, versionId };
}

async function runToCompletion(store: Store, engine: ExecutionEngine, definition: WorkflowDefinition, extra: Record<string, unknown> = {}) {
  const { pipelineId, versionId } = await publish(store, definition);
  const run = await engine.startRun({
    organizationId: ORG, pipelineId, pipelineName: definition.name, pipelineVersionId: versionId,
    version: definition.version, definition, trigger: "manual", triggeredBy: "user_1", ...extra,
  });
  const finished = await engine.executeRunToCompletion(ORG, run.id);
  const tasks = await store.listTasks(ORG, run.id);
  return { run: finished, tasks, pipelineId, versionId };
}

const demoDefinition = PIPELINE_TEMPLATES.find((t) => t.id === "zero-infra-demo")!.definition;

describe("planRun", () => {
  it("queues roots and leaves dependents pending", () => {
    const { run, tasks } = planRun({
      organizationId: ORG, pipelineId: "p", pipelineName: "demo", pipelineVersionId: "v", version: 1,
      definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    expect(run.state).toBe("QUEUED");
    expect(tasks.filter((t) => t.state === "QUEUED").map((t) => t.nodeId)).toEqual(["generate_sales"]);
    expect(tasks.filter((t) => t.state === "PENDING")).toHaveLength(demoDefinition.nodes.length - 1);
    expect(tasks.find((t) => t.nodeId === "publish")?.dependsOn).toEqual(["gate"]);
  });

  it("assigns descending priority by layer so upstream work is claimed first", () => {
    const { tasks } = planRun({
      organizationId: ORG, pipelineId: "p", pipelineName: "demo", pipelineVersionId: "v", version: 1,
      definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    const priority = (nodeId: string) => tasks.find((t) => t.nodeId === nodeId)!.priority;
    expect(priority("generate_sales")).toBeGreaterThan(priority("publish"));
  });

  it("marks unselected nodes SKIPPED when a subset is requested", () => {
    const { tasks } = planRun({
      organizationId: ORG, pipelineId: "p", pipelineName: "demo", pipelineVersionId: "v", version: 1,
      definition: demoDefinition, trigger: "retry", triggeredBy: "u", onlyNodes: ["quality", "gate", "publish"],
    });
    expect(tasks.filter((t) => t.state === "SKIPPED").map((t) => t.nodeId).sort())
      .toEqual(["drop_null_customers", "generate_sales", "revenue_by_customer"]);
  });

  it("throws on a cyclic definition", () => {
    const cyclic: WorkflowDefinition = {
      name: "cyclic", version: 1,
      nodes: [
        { id: "a", type: "generator.source", config: { preset: "sales" } },
        { id: "b", type: "filter.transform", config: { predicates: [] } },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    };
    expect(() => planRun({
      organizationId: ORG, pipelineId: "p", pipelineName: "c", pipelineVersionId: "v", version: 1,
      definition: cyclic, trigger: "manual", triggeredBy: "u",
    })).toThrow(/cycle/i);
  });
});

describe("end-to-end execution", () => {
  it("runs the demo pipeline to SUCCESS and publishes a dataset", async () => {
    const { store, engine } = await setup();
    expect(validateWorkflow(demoDefinition).valid).toBe(true);

    const { run, tasks } = await runToCompletion(store, engine, demoDefinition);
    expect(run.state).toBe("SUCCESS");
    expect(run.totals).toMatchObject({ tasks: 6, succeeded: 6, failed: 0, blocked: 0 });
    expect(tasks.every((t) => t.state === "SUCCESS")).toBe(true);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);

    const dataset = await store.getDatasetRows(ORG, "demo_customer_revenue");
    expect(dataset?.rowCount).toBeGreaterThan(0);
    const catalog = await store.getDataset(ORG, "demo_customer_revenue");
    expect(catalog).toMatchObject({ qualityStatus: "passing" });

    // Aggregation actually happened: fewer output rows than generated rows.
    const aggregate = tasks.find((t) => t.nodeId === "revenue_by_customer")!;
    expect(aggregate.output).toMatchObject({ rowsIn: expect.any(Number), rowsOut: expect.any(Number) });
    expect(Number(aggregate.output!["rowsOut"])).toBeLessThan(Number(aggregate.output!["rowsIn"]));
  });

  it("records structured logs per task attempt", async () => {
    const { store, engine } = await setup();
    const { run } = await runToCompletion(store, engine, demoDefinition);
    const logs = await store.listLogs(ORG, run.id, { limit: 200 });
    expect(logs.items.length).toBeGreaterThan(5);
    expect(logs.items.some((l) => /Retrieved [\d,]+ records/.test(l.message))).toBe(true);
    expect(logs.items.every((l) => l.attempt === 1)).toBe(true);
  });

  it("emits a resumable event stream", async () => {
    const { store, engine } = await setup();
    const { run } = await runToCompletion(store, engine, demoDefinition);
    const events = await store.listRunEvents(ORG, run.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.queued");
    expect(types).toContain("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(types.filter((t) => t === "task.finished")).toHaveLength(6);
    // Sequences are strictly increasing so a reconnecting client can resume.
    expect(events.map((e) => e.sequence)).toEqual([...events.map((e) => e.sequence)].sort((a, b) => a - b));
  });

  it("persists quality results with real numbers", async () => {
    const { store, engine } = await setup();
    const { run } = await runToCompletion(store, engine, demoDefinition);
    const results = await store.listQualityResults(ORG, { runId: run.id });
    expect(results).toHaveLength(5);
    const unique = results.find((r) => r.checkId === "customer_id_unique")!;
    expect(unique.totalRows).toBeGreaterThan(0);
    expect(unique.status).toBe("PASSED");
    expect(unique.passRate).toBe(1);
  });

  it("blocks downstream tasks when a quality gate fails", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "gate-blocks", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ id: 1, email: null }, { id: 2, email: "a@b.co" }], dataset: "raw" } },
        {
          id: "quality", type: "quality.check",
          config: { dataset: "raw", checks: [{ id: "email_not_null", type: "not_null", column: "email" }], onFailure: "warn" },
        },
        { id: "gate", type: "quality.gate", config: { severity: "any_failure", scope: "upstream" } },
        { id: "load", type: "dataset.destination", config: { dataset: "clean", writeMode: "replace" } },
      ],
      edges: [{ from: "src", to: "quality" }, { from: "quality", to: "gate" }, { from: "gate", to: "load" }],
    };

    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(run.error).toMatch(/blocked by a quality gate/);
    expect(tasks.find((t) => t.nodeId === "quality")?.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "gate")?.state).toBe("SUCCESS");
    const load = tasks.find((t) => t.nodeId === "load")!;
    expect(load.state).toBe("BLOCKED");
    expect(load.error).toMatch(/did not pass/);
    // Crucially, the destination never ran.
    expect(await store.getDatasetRows(ORG, "clean")).toBeNull();
  });

  it("lets a passing gate through", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "gate-passes", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ id: 1, email: "a@b.co" }], dataset: "raw" } },
        { id: "quality", type: "quality.check", config: { dataset: "raw", checks: [{ id: "email_not_null", type: "not_null", column: "email" }] } },
        { id: "gate", type: "quality.gate", config: { severity: "any_failure" } },
        { id: "load", type: "dataset.destination", config: { dataset: "clean" } },
      ],
      edges: [{ from: "src", to: "quality" }, { from: "quality", to: "gate" }, { from: "gate", to: "load" }],
    };
    const { run } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("SUCCESS");
    expect((await store.getDatasetRows(ORG, "clean"))?.rowCount).toBe(1);
  });

  it("skips the branch a condition did not select", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "branching", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ id: 1 }], dataset: "raw" } },
        { id: "cond", type: "condition.branch", config: { expression: "row_count_gt", value: 0 } },
        { id: "when_true", type: "dataset.destination", config: { dataset: "has_rows" } },
        { id: "when_false", type: "dataset.destination", config: { dataset: "no_rows" } },
      ],
      edges: [
        { from: "src", to: "cond" },
        { from: "cond", to: "when_true", port: "true" },
        { from: "cond", to: "when_false", port: "false" },
      ],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "when_true")?.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "when_false")?.state).toBe("SKIPPED");
    expect(await store.getDatasetRows(ORG, "no_rows")).toBeNull();
  });

  it("runs independent branches and joins them", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "joining", version: 1,
      nodes: [
        { id: "sales", type: "inline.source", config: { rows: [{ customer_id: "c1", amount: 10 }, { customer_id: "c2", amount: 5 }], dataset: "sales" } },
        { id: "customers", type: "inline.source", config: { rows: [{ id: "c1", name: "Ada" }], dataset: "customers" } },
        { id: "joined", type: "join.transform", config: { left: "sales", right: "customers", on: [{ left: "customer_id", right: "id" }], type: "inner", dataset: "enriched" } },
        { id: "load", type: "dataset.destination", config: { dataset: "enriched" } },
      ],
      edges: [{ from: "sales", to: "joined" }, { from: "customers", to: "joined" }, { from: "joined", to: "load" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "joined")?.output).toMatchObject({ leftRows: 2, rightRows: 1, rowsOut: 1 });
    expect((await store.getDatasetRows(ORG, "enriched"))?.rows[0]).toMatchObject({ name: "Ada" });
  });

  it("registers schema versions and fails on a breaking change", async () => {
    const { store, engine } = await setup();
    const withColumns = (rows: Array<Record<string, unknown>>): WorkflowDefinition => ({
      name: "schema-check", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows, dataset: "contract" } },
        { id: "validate", type: "schema.validate", config: { dataset: "contract", onBreaking: "fail", register: true } },
      ],
      edges: [{ from: "src", to: "validate" }],
    });

    const first = await runToCompletion(store, engine, withColumns([{ id: 1, email: "a@b.co" }]));
    expect(first.run.state).toBe("SUCCESS");
    expect((await store.latestSchema(ORG, "contract"))?.version).toBe(1);

    // Dropping a column is BREAKING and must fail the run.
    const second = await runToCompletion(store, engine, withColumns([{ id: 2 }]));
    expect(second.run.state).toBe("FAILED");
    expect(second.tasks.find((t) => t.nodeId === "validate")?.error).toMatch(/BREAKING/);
  });

  it("writes to a relational destination through the connector", async () => {
    const driver = new MemorySqlDriver({ tables: { "public.revenue": [] } });
    const { store, engine } = await setup({ sqlDriver: driver });
    const now = new Date().toISOString();
    await store.createConnection({
      id: "conn_pg", organizationId: ORG, name: "warehouse", family: "postgres",
      config: { host: "db.internal", database: "app", user: "svc" },
      secretRefs: { password: "api_token" },
      createdBy: "u", createdAt: now, updatedAt: now,
    });

    const definition: WorkflowDefinition = {
      name: "to-postgres", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ customer_id: "c1", revenue: 10 }], dataset: "raw" } },
        {
          id: "load", type: "postgres.destination",
          config: { connectionId: "conn_pg", table: "public.revenue", writeMode: "upsert", keyColumns: ["customer_id"], idempotent: true },
        },
      ],
      edges: [{ from: "src", to: "load" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "load")?.output).toMatchObject({ rowsWritten: 1, target: "public.revenue" });
    expect(driver.rowsIn("public.revenue")).toEqual([{ customer_id: "c1", revenue: 10 }]);
    // The credential was resolved from the connection's secret reference.
    expect(driver.statements.some((s) => s.includes("INSERT INTO"))).toBe(true);
  });

  it("audits every secret read", async () => {
    const driver = new MemorySqlDriver({ tables: { t: [] } });
    const { store, engine } = await setup({ sqlDriver: driver });
    const now = new Date().toISOString();
    await store.createConnection({
      id: "conn_pg", organizationId: ORG, name: "wh", family: "postgres",
      config: { host: "db" }, secretRefs: { password: "api_token" }, createdBy: "u", createdAt: now, updatedAt: now,
    });
    await runToCompletion(store, engine, {
      name: "audit-secret", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "load", type: "postgres.destination", config: { connectionId: "conn_pg", table: "t", writeMode: "append" } },
      ],
      edges: [{ from: "src", to: "load" }],
    });
    const audit = await store.listAudit(ORG, { action: "secret.read" });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actorType: "system", result: "success", resourceId: "api_token" });
  });
});

describe("retries", () => {
  it("retries a transient failure and succeeds on the second attempt", async () => {
    const { store, engine } = await setup();
    let attempts = 0;
    registerExecutor("test.flaky", async (context) => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("connect ECONNREFUSED 10.0.0.1:5432");
        throw error;
      }
      context.log("info", "Succeeded on retry");
      return { batch: Object.values(context.inputs)[0], output: { attempts } };
    });

    const definition: WorkflowDefinition = {
      name: "flaky", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "flaky", type: "test.flaky", config: {}, retry: { maxAttempts: 3, strategy: "fixed", initialDelaySeconds: 0 } },
      ],
      edges: [{ from: "src", to: "flaky" }],
    };
    const { pipelineId, versionId } = await publish(store, definition);
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: definition.name, pipelineVersionId: versionId,
      version: 1, definition, trigger: "manual", triggeredBy: "u",
    });
    const finished = await engine.executeRunToCompletion(ORG, run.id);

    expect(finished.state).toBe("SUCCESS");
    const task = (await store.listTasks(ORG, run.id)).find((t) => t.nodeId === "flaky")!;
    expect(task.attempt).toBe(2);
    const attemptRows = await store.listAttempts(ORG, task.id);
    expect(attemptRows.map((a) => `${a.attempt}:${a.state}`)).toEqual(["1:FAILED", "2:SUCCESS"]);
    expect(attemptRows[0]!.error).toMatch(/ECONNREFUSED/);
  });

  it("does not retry a validation error", async () => {
    const { store, engine } = await setup();
    let attempts = 0;
    registerExecutor("test.invalid", async () => {
      attempts++;
      throw Object.assign(new Error("column amount must be numeric"), { errorClass: "validation" });
    });
    const definition: WorkflowDefinition = {
      name: "invalid", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "bad", type: "test.invalid", config: {}, retry: { maxAttempts: 5, strategy: "fixed", initialDelaySeconds: 0 } },
      ],
      edges: [{ from: "src", to: "bad" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(attempts).toBe(1);
    expect(tasks.find((t) => t.nodeId === "bad")).toMatchObject({ state: "FAILED", errorClass: "validation", attempt: 1 });
  });

  it("gives up after exhausting the retry budget", async () => {
    const { store, engine } = await setup();
    registerExecutor("test.always-fails", async () => {
      throw Object.assign(new Error("503 Service Unavailable"), { errorClass: "transient" });
    });
    const definition: WorkflowDefinition = {
      name: "doomed", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "doomed", type: "test.always-fails", config: {}, retry: { maxAttempts: 3, strategy: "fixed", initialDelaySeconds: 0 } },
        { id: "after", type: "dataset.destination", config: { dataset: "never" } },
      ],
      edges: [{ from: "src", to: "doomed" }, { from: "doomed", to: "after" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(tasks.find((t) => t.nodeId === "doomed")).toMatchObject({ state: "FAILED", attempt: 3 });
    expect(tasks.find((t) => t.nodeId === "after")?.state).toBe("SKIPPED");
    expect(await store.getDatasetRows(ORG, "never")).toBeNull();
  });

  it("schedules the retry in the future according to the backoff", async () => {
    const { store, engine } = await setup();
    registerExecutor("test.backoff", async () => {
      throw Object.assign(new Error("ETIMEDOUT"), { errorClass: "timeout" });
    });
    const definition: WorkflowDefinition = {
      name: "backoff", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "slow", type: "test.backoff", config: {}, retry: { maxAttempts: 3, strategy: "exponential", initialDelaySeconds: 30, multiplier: 6 } },
      ],
      edges: [{ from: "src", to: "slow" }],
    };
    const { pipelineId, versionId } = await publish(store, definition);
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: definition.name, pipelineVersionId: versionId,
      version: 1, definition, trigger: "manual", triggeredBy: "u",
    });
    // Drain the source, then run the failing task exactly once.
    const source = (await store.listTasks(ORG, run.id)).find((t) => t.nodeId === "src")!;
    await engine.runTask((await store.compareAndSetTaskState(ORG, source.id, "QUEUED", { state: "RUNNING" }))!);
    const slow = (await store.listTasks(ORG, run.id)).find((t) => t.nodeId === "slow")!;
    const outcome = await engine.runTask((await store.compareAndSetTaskState(ORG, slow.id, "QUEUED", { state: "RUNNING" }))!);

    expect(outcome.state).toBe("RETRYING");
    expect(new Date(outcome.retryScheduledAt!).getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect((await store.getRun(ORG, run.id))!.state).toBe("RUNNING");
  });

  it("refuses to retry a non-idempotent destructive write", async () => {
    const driver = new MemorySqlDriver({ tables: { t: [] } });
    driver.failNextQueries = 99;
    driver.failureError = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    const { store, engine } = await setup({ sqlDriver: driver });
    const now = new Date().toISOString();
    await store.createConnection({
      id: "conn_pg", organizationId: ORG, name: "wh", family: "postgres",
      config: { host: "db" }, secretRefs: {}, createdBy: "u", createdAt: now, updatedAt: now,
    });
    const definition: WorkflowDefinition = {
      name: "unsafe-retry", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        {
          id: "load", type: "postgres.destination",
          config: { connectionId: "conn_pg", table: "t", writeMode: "append", idempotent: false },
          retry: { maxAttempts: 5, strategy: "fixed", initialDelaySeconds: 0 },
        },
      ],
      edges: [{ from: "src", to: "load" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(tasks.find((t) => t.nodeId === "load")).toMatchObject({ state: "FAILED", attempt: 1 });
  });
});

describe("cancellation", () => {
  it("cancels queued tasks immediately and marks the run CANCELLED", async () => {
    const { store, engine } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demoDefinition.name, pipelineVersionId: versionId,
      version: 1, definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    const cancelled = await engine.cancelRun(ORG, run.id, "user_1");
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.cancellationRequestedBy).toBe("user_1");
    const tasks = await store.listTasks(ORG, run.id);
    expect(tasks.every((t) => t.state === "CANCELLED")).toBe(true);
  });

  it("refuses to execute a task after cancellation was requested", async () => {
    const { store, engine } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demoDefinition.name, pipelineVersionId: versionId,
      version: 1, definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    const task = (await store.listTasks(ORG, run.id)).find((t) => t.state === "QUEUED")!;
    const claimed = (await store.compareAndSetTaskState(ORG, task.id, "QUEUED", { state: "RUNNING", workerId: "w" }))!;
    await store.updateRun(ORG, run.id, { cancellationRequestedAt: new Date().toISOString(), cancellationRequestedBy: "u" });

    const outcome = await engine.runTask(claimed);
    expect(outcome.state).toBe("CANCELLED");
    expect((await store.getRun(ORG, run.id))!.state).toBe("CANCELLED");
  });

  it("aborts a running task when cancellation is requested mid-flight", async () => {
    const { store } = await setup();
    const engine = new ExecutionEngine({
      store,
      secrets: new EnvironmentSecretProvider({}),
      logger: silent,
      heartbeatMs: 10,
    });
    registerExecutor("test.long", async (context) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(context.signal.reason);
        }, { once: true });
      });
      return { output: {} };
    });
    const definition: WorkflowDefinition = {
      name: "long-running", version: 1,
      nodes: [{ id: "slow", type: "test.long", config: {} }],
      edges: [],
    };
    const { pipelineId, versionId } = await publish(store, definition);
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: definition.name, pipelineVersionId: versionId,
      version: 1, definition, trigger: "manual", triggeredBy: "u",
    });
    const task = (await store.listTasks(ORG, run.id))[0]!;
    const claimed = (await store.compareAndSetTaskState(ORG, task.id, "QUEUED", { state: "RUNNING", workerId: engine.workerId }))!;

    const execution = engine.runTask(claimed);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.updateRun(ORG, run.id, { cancellationRequestedAt: new Date().toISOString(), cancellationRequestedBy: "u" });
    const outcome = await execution;

    expect(outcome.state).toBe("CANCELLED");
    expect(outcome.durationMs).toBeLessThan(5000);
  }, 20_000);

  it("cancels a single task and skips its dependents", async () => {
    const { store, engine } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    const started = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demoDefinition.name, pipelineVersionId: versionId,
      version: 1, definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    const task = (await store.listTasks(ORG, started.id)).find((t) => t.nodeId === "generate_sales")!;
    await engine.cancelTask(ORG, task.id, "user_1");
    const finished = await store.getRun(ORG, started.id);
    expect(finished?.state).toBe("FAILED");
    const tasks = await store.listTasks(ORG, started.id);
    expect(tasks.find((t) => t.nodeId === "generate_sales")?.state).toBe("CANCELLED");
    expect(tasks.filter((t) => t.state === "SKIPPED")).toHaveLength(5);
  });
});

describe("timeouts and recovery", () => {
  it("fails a task that exceeds its timeout", async () => {
    const { store } = await setup();
    const engine = new ExecutionEngine({ store, secrets: new EnvironmentSecretProvider({}), logger: silent, heartbeatMs: 1_000_000 });
    registerExecutor("test.sleepy", async (context) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3000);
        context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
      });
      return { output: {} };
    });
    const definition: WorkflowDefinition = {
      name: "timeout-test", version: 1,
      nodes: [{ id: "sleepy", type: "test.sleepy", config: {}, timeoutSeconds: 1, retry: { maxAttempts: 1, strategy: "fixed" } }],
      edges: [],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(tasks[0]).toMatchObject({ state: "FAILED", errorClass: "timeout" });
    expect(tasks[0]!.error).toMatch(/exceeded its 1s timeout/);
  }, 20_000);

  it("recovers a task whose worker died", async () => {
    const { store, engine } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demoDefinition.name, pipelineVersionId: versionId,
      version: 1, definition: demoDefinition, trigger: "manual", triggeredBy: "u",
    });
    const now = new Date();
    const claimed = await store.claimNextTask({ workerId: "worker-that-dies", leaseSeconds: 30, now });
    expect(claimed?.state).toBe("RUNNING");

    // Worker vanishes; another worker reclaims the task once the lease lapses.
    const later = new Date(now.getTime() + 60_000);
    expect((await store.reclaimExpiredLeases(later)).map((t) => t.id)).toContain(claimed!.id);
    const reclaimed = await store.claimNextTask({ workerId: "worker-b", leaseSeconds: 30, now: later });
    expect(reclaimed?.id).toBe(claimed!.id);
    const outcome = await engine.runTask(reclaimed!);
    expect(outcome.state).toBe("SUCCESS");
  });

  it("rejects an intermediate batch that exceeds the control-plane limit", async () => {
    const { store } = await setup();
    const engine = new ExecutionEngine({
      store, secrets: new EnvironmentSecretProvider({}), logger: silent, maxBatchBytes: 1024, heartbeatMs: 1_000_000,
    });
    const definition: WorkflowDefinition = {
      name: "too-big", version: 1,
      nodes: [
        { id: "src", type: "generator.source", config: { preset: "sales", rowCount: 5000 }, retry: { maxAttempts: 1, strategy: "fixed" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "big" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(tasks.find((t) => t.nodeId === "src")?.error).toMatch(/over the .* MB limit/);
  });
});

describe("retryRun", () => {
  it("re-runs only the failed node and its descendants", async () => {
    const { store, engine } = await setup();
    let shouldFail = true;
    registerExecutor("test.toggle", async (context) => {
      if (shouldFail) throw Object.assign(new Error("boom"), { errorClass: "validation" });
      return { batch: Object.values(context.inputs)[0], output: { ok: true } };
    });
    const definition: WorkflowDefinition = {
      name: "retry-subset", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "middle", type: "test.toggle", config: {}, retry: { maxAttempts: 1, strategy: "fixed" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out" } },
      ],
      edges: [{ from: "src", to: "middle" }, { from: "middle", to: "sink" }],
    };
    const first = await runToCompletion(store, engine, definition);
    expect(first.run.state).toBe("FAILED");

    shouldFail = false;
    const retried = await engine.retryRun(ORG, first.run.id, "user_1");
    const finished = await engine.executeRunToCompletion(ORG, retried.id);
    expect(finished.state).toBe("SUCCESS");
    expect(finished.retryOfRunId).toBe(first.run.id);
    expect(finished.trigger).toBe("retry");

    const tasks = await store.listTasks(ORG, retried.id);
    // The failed node, its ancestors (needed for input) and its descendants re-run.
    expect(tasks.find((t) => t.nodeId === "src")?.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "middle")?.state).toBe("SUCCESS");
    expect(tasks.find((t) => t.nodeId === "sink")?.state).toBe("SUCCESS");
  });

  it("re-runs everything when asked", async () => {
    const { store, engine } = await setup();
    const first = await runToCompletion(store, engine, demoDefinition);
    const retried = await engine.retryRun(ORG, first.run.id, "user_1", { allNodes: true });
    const tasks = await store.listTasks(ORG, retried.id);
    expect(tasks.filter((t) => t.state === "SKIPPED")).toHaveLength(0);
  });
});

describe("python sandbox", () => {
  it("refuses to run Python when no sandbox is configured", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "python-disabled", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ amount: 1 }] } },
        { id: "py", type: "python.transform", config: { code: "def transform(rows):\n    return rows", entrypoint: "transform" }, retry: { maxAttempts: 1, strategy: "fixed" } },
      ],
      edges: [{ from: "src", to: "py" }],
    };
    const { run, tasks } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("FAILED");
    expect(tasks.find((t) => t.nodeId === "py")?.error).toMatch(/Python execution is disabled/);
    expect(tasks.find((t) => t.nodeId === "py")?.errorClass).toBe("configuration");
  });

  it("reports the disabled sandbox through the provider interface", async () => {
    await expect(new DisabledPythonSandbox().run()).rejects.toThrow(/never evaluates user Python/);
    expect(new DisabledPythonSandbox().available).toBe(false);
  });

  it("executes Python in a subprocess sandbox when one is configured", async () => {
    const sandbox = new SubprocessPythonSandbox();
    const probe = await sandbox
      .run({ code: "def t(rows):\n    return rows", entrypoint: "t", rows: [{ a: 1 }], timeoutSeconds: 10, memoryLimitMb: 128, networkAccess: false })
      .catch((error) => error as Error);
    if (probe instanceof Error) {
      // No python3 on this machine: the sandbox must say so rather than pretend.
      expect(probe.message).toMatch(/interpreter|not found/i);
      return;
    }
    expect(probe.rows).toEqual([{ a: 1 }]);

    const { store } = await setup();
    const engine = new ExecutionEngine({ store, secrets: new EnvironmentSecretProvider({}), logger: silent, sandbox, heartbeatMs: 1_000_000 });
    const definition: WorkflowDefinition = {
      name: "python-enabled", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ amount: 5 }, { amount: -1 }] } },
        {
          id: "py", type: "python.transform",
          config: { code: "def transform(rows):\n    return [r for r in rows if r['amount'] > 0]", entrypoint: "transform", timeoutSeconds: 20 },
          retry: { maxAttempts: 1, strategy: "fixed" },
        },
        { id: "sink", type: "dataset.destination", config: { dataset: "py_out" } },
      ],
      edges: [{ from: "src", to: "py" }, { from: "py", to: "sink" }],
    };
    const { run } = await runToCompletion(store, engine, definition);
    expect(run.state).toBe("SUCCESS");
    expect((await store.getDatasetRows(ORG, "py_out"))?.rows).toEqual([{ amount: 5 }]);
  }, 60_000);

  it("enforces the sandbox timeout", async () => {
    const sandbox = new SubprocessPythonSandbox();
    const result = await sandbox
      .run({ code: "import time\ndef t(rows):\n    time.sleep(10)\n    return rows", entrypoint: "t", rows: [], timeoutSeconds: 1, memoryLimitMb: 128, networkAccess: false })
      .catch((error) => error as Error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timeout|interpreter|not found/i);
  }, 30_000);
});

describe("incident detection", () => {
  it("opens an incident after three consecutive failures", async () => {
    const { store, engine } = await setup();
    registerExecutor("test.broken", async () => {
      throw Object.assign(new Error("nope"), { errorClass: "validation" });
    });
    const definition: WorkflowDefinition = {
      name: "always-broken", version: 1,
      nodes: [{ id: "bad", type: "test.broken", config: {}, retry: { maxAttempts: 1, strategy: "fixed" } }],
      edges: [],
    };
    const { pipelineId, versionId } = await publish(store, definition);
    for (let i = 0; i < 3; i++) {
      const run = await engine.startRun({
        organizationId: ORG, pipelineId, pipelineName: definition.name, pipelineVersionId: versionId,
        version: 1, definition, trigger: "schedule", triggeredBy: "system",
      });
      await engine.executeRunToCompletion(ORG, run.id);
    }
    const incidents = await store.listIncidents(ORG, { status: "open" });
    const repeated = incidents.items.find((i) => i.kind === "repeated_failure");
    expect(repeated).toBeDefined();
    expect(repeated!.title).toMatch(/failed 3 consecutive times/);
    expect(repeated!.evidence["consecutiveFailures"]).toBe(3);
    expect((repeated!.evidence["runIds"] as string[]).length).toBe(3);
  });

  it("opens a quality incident with the failing check as evidence", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "quality-incident", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ id: null }], dataset: "raw" } },
        { id: "quality", type: "quality.check", config: { dataset: "raw", checks: [{ id: "id_not_null", type: "not_null", column: "id" }] } },
      ],
      edges: [{ from: "src", to: "quality" }],
    };
    const { run } = await runToCompletion(store, engine, definition);
    const incidents = await store.listIncidents(ORG);
    const quality = incidents.items.find((i) => i.kind === "quality_failure");
    expect(quality).toBeDefined();
    expect(quality!.dataset).toBe("raw");
    expect((quality!.evidence["checks"] as unknown[]).length).toBe(1);
    expect(quality!.evidence["runId"]).toBe(run.id);
  });

  it("does not open an incident for a healthy run", async () => {
    const { store, engine } = await setup();
    await runToCompletion(store, engine, demoDefinition);
    expect((await store.listIncidents(ORG)).items).toHaveLength(0);
  });

  it("deduplicates repeat incidents by fingerprint", async () => {
    const { store, engine } = await setup();
    const definition: WorkflowDefinition = {
      name: "repeat-quality", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ id: null }], dataset: "raw2" } },
        { id: "quality", type: "quality.check", config: { dataset: "raw2", checks: [{ id: "c", type: "not_null", column: "id" }] } },
      ],
      edges: [{ from: "src", to: "quality" }],
    };
    await runToCompletion(store, engine, definition);
    await runToCompletion(store, engine, definition);
    const incidents = (await store.listIncidents(ORG)).items.filter((i) => i.kind === "quality_failure");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.occurrences).toBe(2);
  });

  it("detects a duration spike against the recent average", async () => {
    const { store } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    const base = Date.now();
    for (let i = 0; i < 6; i++) {
      await store.createRun({
        id: newId("run"), organizationId: ORG, pipelineId, pipelineVersionId: versionId,
        pipelineName: "demo-daily-sales", version: 1, state: "SUCCESS", trigger: "schedule", triggeredBy: "system",
        queuedAt: new Date(base - (i + 1) * 60_000).toISOString(), durationMs: 40_000,
      }, []);
    }
    const slow = {
      id: newId("run"), organizationId: ORG, pipelineId, pipelineVersionId: versionId,
      pipelineName: "demo-daily-sales", version: 1, state: "SUCCESS" as const, trigger: "schedule" as const,
      triggeredBy: "system", queuedAt: new Date(base).toISOString(), durationMs: 200_000,
    };
    await store.createRun(slow, []);
    const incidents = await detectIncidents(store, slow, { logger: silent });
    const spike = incidents.find((i) => i.kind === "duration_spike");
    expect(spike).toBeDefined();
    expect(spike!.evidence).toMatchObject({ durationMs: 200_000, recentAverageMs: 40_000, multiplier: 5 });
  });

  it("detects a stale dataset against its schedule", async () => {
    const { store } = await setup();
    const { pipelineId, versionId } = await publish(store, demoDefinition);
    const now = new Date("2026-03-31T12:00:00Z");
    const runId = newId("run");
    await store.createRun({
      id: runId, organizationId: ORG, pipelineId, pipelineVersionId: versionId, pipelineName: "demo", version: 1,
      state: "SUCCESS", trigger: "schedule", triggeredBy: "system", queuedAt: "2026-03-01T00:00:00.000Z",
    }, []);
    await store.upsertDataset({
      id: newId("ds"), organizationId: ORG, name: "stale_table", lastUpdatedAt: "2026-03-01T00:00:00.000Z",
      lastRunId: runId, createdAt: "2026-03-01T00:00:00.000Z",
    });
    await store.createSchedule({
      id: newId("sch"), organizationId: ORG, pipelineId, kind: "interval", intervalSeconds: 86_400,
      timezone: "UTC", enabled: true, catchup: false, nextRunAt: now.toISOString(),
      createdBy: "u", createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    const incidents = await detectStaleDatasets(store, ORG, { now });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.evidence).toMatchObject({ dataset: "stale_table", expectedEverySeconds: 86_400 });
  });
});

describe("failure investigation", () => {
  it("gathers evidence without inventing a cause", async () => {
    const { store, engine } = await setup();
    registerExecutor("test.explodes", async (context) => {
      context.log("info", "Connecting to PostgreSQL");
      throw Object.assign(new Error('relation "sales" does not exist'), { errorClass: "not_found" });
    });
    const definition: WorkflowDefinition = {
      name: "investigate-me", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }] } },
        { id: "boom", type: "test.explodes", config: {}, retry: { maxAttempts: 1, strategy: "fixed" } },
        { id: "after", type: "dataset.destination", config: { dataset: "never2" } },
      ],
      edges: [{ from: "src", to: "boom" }, { from: "boom", to: "after" }],
    };
    const { run } = await runToCompletion(store, engine, definition);
    const evidence = await gatherFailureEvidence(store, ORG, run.id);

    expect(evidence.run.state).toBe("FAILED");
    expect(evidence.failedTask?.nodeId).toBe("boom");
    expect(evidence.failedTask?.errorClass).toBe("not_found");
    expect(evidence.attempts.length).toBeGreaterThan(0);
    expect(evidence.logs.some((l) => l.message.includes("Connecting to PostgreSQL"))).toBe(true);
    expect(evidence.logs.some((l) => l.level === "error")).toBe(true);
    expect(evidence.affectedTasks.map((t) => t.nodeId)).toEqual(["after"]);
    expect(evidence.recurrence.runs).toBe(1);
    expect(evidence.lastSuccessfulRun).toBeNull();
    expect(evidence.versionDiff).toBeNull();
  });

  it("includes the version diff when the definition changed since the last success", async () => {
    const { store, engine } = await setup();
    const v1: WorkflowDefinition = {
      name: "changed", version: 1,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }], dataset: "d" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out3" } },
      ],
      edges: [{ from: "src", to: "sink" }],
    };
    const first = await runToCompletion(store, engine, v1);
    expect(first.run.state).toBe("SUCCESS");

    const v2: WorkflowDefinition = {
      ...v1, version: 2,
      nodes: [
        { id: "src", type: "inline.source", config: { rows: [{ a: 1 }], dataset: "d" } },
        { id: "broken", type: "filter.transform", config: { predicates: [{ column: "ghost", op: "not_null" }], onEmpty: "fail" }, retry: { maxAttempts: 1, strategy: "fixed" } },
        { id: "sink", type: "dataset.destination", config: { dataset: "out3" } },
      ],
      edges: [{ from: "src", to: "broken" }, { from: "broken", to: "sink" }],
    };
    const versionId = newId("ver");
    const now = new Date().toISOString();
    await store.createVersion({
      id: versionId, organizationId: ORG, pipelineId: first.pipelineId, version: 2, status: "published",
      definition: v2, definitionHash: "hash2", createdBy: "u", createdAt: now, publishedAt: now,
    });
    const run = await engine.startRun({
      organizationId: ORG, pipelineId: first.pipelineId, pipelineName: v2.name, pipelineVersionId: versionId,
      version: 2, definition: v2, trigger: "manual", triggeredBy: "u",
    });
    await engine.executeRunToCompletion(ORG, run.id);

    const evidence = await gatherFailureEvidence(store, ORG, run.id);
    expect(evidence.run.state).toBe("FAILED");
    expect(evidence.lastSuccessfulRun?.id).toBe(first.run.id);
    expect(evidence.versionDiff?.addedNodes.map((n) => n.id)).toEqual(["broken"]);
  });
});

describe("executor registry", () => {
  it("reports a node type it cannot execute", () => {
    expect(() => executorFor("snowflake.source")).toThrow(/No executor is registered/);
  });
});

describe("advanceRun idempotency", () => {
  it("is safe to call repeatedly and concurrently", async () => {
    const { store, engine } = await setup();
    const { run } = await runToCompletion(store, engine, demoDefinition);
    const [a, b, c] = await Promise.all([
      engine.advanceRun(ORG, run.id),
      engine.advanceRun(ORG, run.id),
      engine.advanceRun(ORG, run.id),
    ]);
    expect([a.state, b.state, c.state]).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    const events = await store.listRunEvents(ORG, run.id);
    expect(events.filter((e) => e.type === "run.finished").length).toBeGreaterThanOrEqual(1);
  });
});
