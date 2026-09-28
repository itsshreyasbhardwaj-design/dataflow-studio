import { describe, expect, it } from "vitest";
import { MemoryStore, type Store } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, MemorySink, newId } from "@dataflow-studio/observability";
import { EnvironmentSecretProvider } from "@dataflow-studio/secrets";
import { buildSchedule, planBackfill } from "@dataflow-studio/scheduler";
import { PIPELINE_TEMPLATES, type WorkflowDefinition } from "@dataflow-studio/workflow-engine";
import { Worker } from "./worker.js";

const silent = new Logger({ level: "error", sink: new MemorySink() });
const ORG = "org_worker";
const demo = PIPELINE_TEMPLATES.find((t) => t.id === "zero-infra-demo")!.definition;

async function setup(definition: WorkflowDefinition = demo) {
  const store: Store = new MemoryStore();
  await store.createOrganization({ id: ORG, name: "T", slug: "t", createdAt: new Date().toISOString() });
  const engine = new ExecutionEngine({
    store, secrets: new EnvironmentSecretProvider({}), logger: silent, heartbeatMs: 1_000_000, leaseSeconds: 60,
  });
  const now = new Date().toISOString();
  const pipelineId = newId("pipe");
  const versionId = newId("ver");
  await store.createPipeline({
    id: pipelineId, organizationId: ORG, name: definition.name, publishedVersionId: versionId,
    latestVersionNumber: 1, createdBy: "u", createdAt: now, updatedAt: now,
  });
  await store.createVersion({
    id: versionId, organizationId: ORG, pipelineId, version: 1, status: "published",
    definition, definitionHash: "h", createdBy: "u", createdAt: now, publishedAt: now,
  });
  const worker = new Worker({ store, engine, logger: silent, concurrency: 1, idlePollMs: 1, runScheduler: false });
  return { store, engine, worker, pipelineId, versionId };
}

describe("Worker.executeOne", () => {
  it("returns null when there is nothing to do", async () => {
    const { worker } = await setup();
    expect(await worker.executeOne()).toBeNull();
    expect(worker.snapshot.tasksExecuted).toBe(0);
  });

  it("claims and executes a queued task", async () => {
    const { store, engine, worker, pipelineId, versionId } = await setup();
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    const outcome = await worker.executeOne();
    expect(outcome?.state).toBe("SUCCESS");
    expect(outcome?.task.nodeId).toBe("generate_sales");
    expect(worker.snapshot).toMatchObject({ tasksExecuted: 1, tasksSucceeded: 1 });
    expect((await store.getRun(ORG, run.id))!.state).toBe("RUNNING");
  });

  it("drains a whole run one task at a time", async () => {
    const { store, engine, worker, pipelineId, versionId } = await setup();
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    for (let i = 0; i < 20; i++) {
      if (!(await worker.executeOne())) break;
    }
    const finished = await store.getRun(ORG, run.id);
    expect(finished?.state).toBe("SUCCESS");
    expect(worker.snapshot.tasksExecuted).toBe(6);
  });

  it("only claims the node types it is configured for", async () => {
    const { store, engine, pipelineId, versionId } = await setup();
    await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    const sqlOnly = new Worker({ store, engine, logger: silent, nodeTypes: ["sql.transform"], runScheduler: false });
    expect(await sqlOnly.executeOne()).toBeNull();

    const generatorOnly = new Worker({ store, engine, logger: silent, nodeTypes: ["generator.source"], runScheduler: false });
    expect((await generatorOnly.executeOne())?.task.nodeId).toBe("generate_sales");
  });

  it("does not let two workers claim the same task", async () => {
    const { store, engine, pipelineId, versionId } = await setup();
    await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    const a = new Worker({ store, engine, logger: silent, runScheduler: false });
    const b = new Worker({ store, engine, logger: silent, runScheduler: false });
    const [first, second] = await Promise.all([a.executeOne(), b.executeOne()]);
    const claimed = [first, second].filter(Boolean);
    // Exactly one of them gets the single ready task.
    expect(claimed).toHaveLength(1);
  });
});

describe("Worker.reclaimLeases", () => {
  it("returns an abandoned task to the queue and advances the run", async () => {
    const { store, engine, worker, pipelineId, versionId } = await setup();
    const run = await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    // A worker claims the task with a short lease, then disappears.
    const claimed = await store.claimNextTask({ workerId: "dead-worker", leaseSeconds: 1 });
    expect(claimed).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const reclaimed = await worker.reclaimLeases();
    expect(reclaimed).toBe(1);
    expect((await store.getTask(ORG, claimed!.id))!.state).toBe("QUEUED");
    expect(worker.snapshot.leasesReclaimed).toBe(1);

    // The run is still executable afterwards.
    for (let i = 0; i < 20; i++) if (!(await worker.executeOne())) break;
    expect((await store.getRun(ORG, run.id))!.state).toBe("SUCCESS");
  });

  it("leaves a healthy lease alone", async () => {
    const { store, engine, worker, pipelineId, versionId } = await setup();
    await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });
    await store.claimNextTask({ workerId: "healthy", leaseSeconds: 600 });
    expect(await worker.reclaimLeases()).toBe(0);
  });
});

describe("Worker.tickScheduler", () => {
  it("starts a run for a due schedule", async () => {
    const { store, engine, pipelineId } = await setup();
    const worker = new Worker({ store, engine, logger: silent, runScheduler: false });
    const schedule = buildSchedule({
      organizationId: ORG, pipelineId, kind: "interval", intervalSeconds: 60,
      createdBy: "u", now: new Date(Date.now() - 120_000),
    });
    await store.createSchedule(schedule);

    expect(await worker.tickScheduler()).toBe(1);
    const runs = await store.listRuns(ORG, { scheduleId: schedule.id });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ trigger: "schedule", triggeredBy: `schedule:${schedule.id}` });
    expect(runs.items[0]!.logicalDate).toBeTruthy();
  });

  it("skips a schedule whose pipeline has no published version", async () => {
    const store: Store = new MemoryStore();
    await store.createOrganization({ id: ORG, name: "T", slug: "t2", createdAt: new Date().toISOString() });
    const engine = new ExecutionEngine({ store, secrets: new EnvironmentSecretProvider({}), logger: silent });
    const now = new Date().toISOString();
    const pipelineId = newId("pipe");
    await store.createPipeline({
      id: pipelineId, organizationId: ORG, name: "unpublished", publishedVersionId: null,
      latestVersionNumber: 1, createdBy: "u", createdAt: now, updatedAt: now,
    });
    await store.createSchedule(buildSchedule({
      organizationId: ORG, pipelineId, kind: "interval", intervalSeconds: 60,
      createdBy: "u", now: new Date(Date.now() - 120_000),
    }));
    const worker = new Worker({ store, engine, logger: silent, runScheduler: false });
    expect(await worker.tickScheduler()).toBe(0);
    expect((await store.listRuns(ORG)).items).toHaveLength(0);
  });

  it("does not double-dispatch the same logical date", async () => {
    const { store, engine, pipelineId } = await setup();
    const worker = new Worker({ store, engine, logger: silent, runScheduler: false });
    await store.createSchedule(buildSchedule({
      organizationId: ORG, pipelineId, kind: "interval", intervalSeconds: 3600,
      createdBy: "u", now: new Date(Date.now() - 7200_000),
    }));
    expect(await worker.tickScheduler()).toBe(1);
    expect(await worker.tickScheduler()).toBe(0);
    expect((await store.listRuns(ORG)).items).toHaveLength(1);
  });
});

describe("Worker.tickBackfills", () => {
  it("dispatches up to the configured concurrency", async () => {
    const { store, engine, pipelineId, versionId } = await setup();
    const worker = new Worker({ store, engine, logger: silent, runScheduler: false });
    const backfill = planBackfill({
      organizationId: ORG, pipelineId, pipelineVersionId: versionId, createdBy: "u",
      from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-05T00:00:00Z"),
      intervalSeconds: 86_400, concurrency: 2, now: new Date("2026-06-01T00:00:00Z"),
    });
    await store.createBackfill(backfill);

    const dispatched = await worker.tickBackfills();
    expect(dispatched).toBe(2);
    const runs = await store.listRuns(ORG, { backfillId: backfill.id });
    expect(runs.items).toHaveLength(2);
    expect(runs.items.every((r) => r.trigger === "backfill" && r.logicalDate)).toBe(true);
  });

  it("does not dispatch a cancelled backfill", async () => {
    const { store, engine, pipelineId, versionId } = await setup();
    const worker = new Worker({ store, engine, logger: silent, runScheduler: false });
    const backfill = planBackfill({
      organizationId: ORG, pipelineId, pipelineVersionId: versionId, createdBy: "u",
      from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-03T00:00:00Z"),
      intervalSeconds: 86_400, now: new Date("2026-06-01T00:00:00Z"),
    });
    await store.createBackfill({ ...backfill, state: "cancelled" });
    expect(await worker.tickBackfills()).toBe(0);
  });
});

describe("Worker lifecycle", () => {
  it("drains in-flight work on stop", async () => {
    const { store, engine, pipelineId, versionId } = await setup();
    const worker = new Worker({ store, engine, logger: silent, concurrency: 2, idlePollMs: 5, runScheduler: false });
    await engine.startRun({
      organizationId: ORG, pipelineId, pipelineName: demo.name, pipelineVersionId: versionId,
      version: 1, definition: demo, trigger: "manual", triggeredBy: "u",
    });

    const started = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stats = await worker.stop({ timeoutMs: 5000 });
    await started;

    expect(stats.tasksExecuted).toBeGreaterThan(0);
    expect(stats.inFlight).toBe(0);
  }, 20_000);

  it("refuses to start twice", async () => {
    const { worker } = await setup();
    const started = worker.start();
    await expect(worker.start()).rejects.toThrow(/already running/);
    await worker.stop();
    await started;
  });
});
