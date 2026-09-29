import { ConnectorRegistry, policyFromEnvironment, type EgressPolicy, type SqlDriver } from "@dataflow-studio/connectors";
import type {
  Store, TaskAttempt, TaskLogEntry, TaskRun, WorkflowRun,
} from "@dataflow-studio/database";
import type { QualityResult } from "@dataflow-studio/data-quality";
import { Logger, MemorySink, metrics, newId, newWorkerId, rootLogger } from "@dataflow-studio/observability";
import { SchemaRegistry, makeBatch, type DataBatch } from "@dataflow-studio/schema-registry";
import { resolveSecrets, type SecretProvider } from "@dataflow-studio/secrets";
import {
  applyDefaults, buildIndex, classifyError, getNodeType, planRetry,
  type JsonObject, type NodeConfig, type RunState, type TaskState, type WorkflowDefinition, type WorkflowNode,
} from "@dataflow-studio/workflow-engine";
import { TaskFailure, type TaskContext, type TaskResult } from "./context.js";
import { executorFor } from "./executors.js";
import { detectIncidents } from "./incidents.js";
import { planRun, type PlanRunInput } from "./planner.js";
import { DisabledPythonSandbox, type PythonSandbox } from "./sandbox.js";

export interface EngineOptions {
  store: Store;
  secrets: SecretProvider;
  logger?: Logger;
  sandbox?: PythonSandbox;
  egressPolicy?: EgressPolicy;
  sqlDrivers?: { postgres?: SqlDriver; mysql?: SqlDriver };
  clock?: () => Date;
  /** How long a claimed task may run before another worker may reclaim it. */
  leaseSeconds?: number;
  /** Cap on a batch handed between tasks through the control plane. */
  maxBatchBytes?: number;
  /** Interval for lease renewal and cancellation polling. */
  heartbeatMs?: number;
}

export interface TaskOutcome {
  task: TaskRun;
  state: TaskState;
  error?: string;
  errorClass?: string;
  retryScheduledAt?: string;
  durationMs: number;
}

const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * The DAG executor.
 *
 * Responsibilities are deliberately split: `startRun` plans, `runTask` executes
 * exactly one task attempt, and `advanceRun` decides what becomes runnable next.
 * A worker loop only ever calls `claimNextTask` then `runTask`, so the same code
 * path serves one in-process worker during `pnpm dev` and a fleet of them against
 * PostgreSQL in production.
 */
export class ExecutionEngine {
  private readonly store: Store;
  private readonly secrets: SecretProvider;
  private readonly logger: Logger;
  private readonly sandbox: PythonSandbox;
  private readonly egressPolicy: EgressPolicy;
  private readonly sqlDrivers: EngineOptions["sqlDrivers"];
  private readonly clock: () => Date;
  private readonly leaseSeconds: number;
  private readonly maxBatchBytes: number;
  private readonly heartbeatMs: number;
  readonly workerId: string;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.logger = options.logger ?? rootLogger;
    this.sandbox = options.sandbox ?? new DisabledPythonSandbox();
    this.egressPolicy = options.egressPolicy ?? policyFromEnvironment();
    this.sqlDrivers = options.sqlDrivers;
    this.clock = options.clock ?? (() => new Date());
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.workerId = newWorkerId();
  }

  // ----------------------------------------------------------------- starting

  async startRun(input: PlanRunInput): Promise<WorkflowRun> {
    const { run, tasks } = planRun({ ...input, now: input.now ?? this.clock() });
    await this.store.createRun(run, tasks);
    await this.store.appendRunEvent({
      organizationId: run.organizationId,
      runId: run.id,
      type: "run.queued",
      payload: { pipelineId: run.pipelineId, version: run.version, trigger: run.trigger, tasks: tasks.length },
    });
    metrics.increment("dataflow_runs_started_total", { pipeline: run.pipelineName, trigger: run.trigger });
    this.logger.info("Run queued", { runId: run.id, pipelineId: run.pipelineId, tasks: tasks.length });
    return run;
  }

  // ---------------------------------------------------------------- one task

  /**
   * Executes a single attempt of one task. The task must already be claimed
   * (state RUNNING with this worker's lease).
   */
  async runTask(claimed: TaskRun): Promise<TaskOutcome> {
    const startedAt = this.clock();
    const organizationId = claimed.organizationId;
    const run = await this.store.getRun(organizationId, claimed.runId);
    if (!run) {
      return this.failTask(claimed, "Run no longer exists", "not_found", startedAt);
    }

    // Cancellation wins over everything, including a task that is already claimed.
    if (run.cancellationRequestedAt || run.state === "CANCELLED") {
      const cancelled = await this.store.updateTask(organizationId, claimed.id, {
        state: "CANCELLED",
        finishedAt: startedAt.toISOString(),
        workerId: null,
        leaseExpiresAt: null,
        error: "Run was cancelled",
      });
      await this.emitTaskEvent(cancelled, "task.finished", { state: "CANCELLED" });
      await this.advanceRun(organizationId, run.id);
      return { task: cancelled, state: "CANCELLED", durationMs: 0, error: "Run was cancelled" };
    }

    const version = await this.store.getVersion(organizationId, run.pipelineVersionId);
    if (!version) {
      return this.failTask(claimed, `Pipeline version ${run.pipelineVersionId} no longer exists`, "not_found", startedAt);
    }
    const definition = version.definition;
    const node = definition.nodes.find((n) => n.id === claimed.nodeId);
    if (!node) {
      return this.failTask(claimed, `Node "${claimed.nodeId}" is not present in this pipeline version`, "configuration", startedAt);
    }

    const attempt = claimed.attempt + 1;
    const logSink = new MemorySink(5000);
    const taskLogger = this.logger.withSink(logSink).child({
      organizationId,
      pipelineId: run.pipelineId,
      runId: run.id,
      taskId: claimed.id,
      nodeId: node.id,
      attempt,
      workerId: this.workerId,
    });

    const logs: TaskLogEntry[] = [];
    const log = (level: TaskLogEntry["level"], message: string, fields?: JsonObject): void => {
      taskLogger.log(level, message, fields);
      logs.push({
        id: newId("evt"),
        organizationId,
        runId: run.id,
        taskRunId: claimed.id,
        attempt,
        timestamp: this.clock().toISOString(),
        level,
        message,
        ...(fields ? { fields } : {}),
      });
    };

    await this.store.updateTask(organizationId, claimed.id, { attempt, startedAt: startedAt.toISOString(), error: null, errorClass: null });
    await this.store.appendAttempt({
      id: newId("att"),
      organizationId,
      taskRunId: claimed.id,
      runId: run.id,
      attempt,
      state: "RUNNING",
      startedAt: startedAt.toISOString(),
      workerId: this.workerId,
    });
    await this.emitTaskEvent(claimed, "task.started", { attempt, nodeType: node.type });

    const controller = new AbortController();
    const timeoutSeconds = node.timeoutSeconds ?? definition.defaults?.timeoutSeconds;
    const timeoutTimer = timeoutSeconds
      ? setTimeout(() => controller.abort(new TaskFailure(`Task exceeded its ${timeoutSeconds}s timeout`, "timeout")), timeoutSeconds * 1000)
      : null;

    // Renew the lease and poll for cancellation while the task runs.
    const heartbeat = setInterval(() => {
      void (async () => {
        await this.store.extendLease(organizationId, claimed.id, this.workerId, this.leaseSeconds).catch(() => undefined);
        const current = await this.store.getRun(organizationId, run.id).catch(() => null);
        if (current?.cancellationRequestedAt && !controller.signal.aborted) {
          controller.abort(new TaskFailure("Run was cancelled", "cancelled"));
        }
      })();
    }, this.heartbeatMs);

    let connectors: ConnectorRegistry | undefined;
    try {
      const config = await this.resolveNodeConfig(organizationId, node, run.id);
      connectors = new ConnectorRegistry({
        organizationId,
        runId: run.id,
        datasetStore: {
          putDataset: (org, dataset, payload) => this.store.putDataset(org, dataset, payload as never),
          getDataset: (org, dataset) => this.store.getDatasetRows(org, dataset) as never,
        },
        fileStore: {
          readFile: async (org, fileId) => {
            const stored = await this.store.getFile(org, fileId);
            if (!stored) throw new TaskFailure(`Uploaded file "${fileId}" was not found`, "not_found");
            return { content: stored.content, filename: stored.file.filename, ...(stored.file.contentType ? { contentType: stored.file.contentType } : {}) };
          },
          writeFile: async (org, filename, content, contentType) => {
            const file = {
              id: newId("evt"), organizationId: org, filename, bytes: content.byteLength,
              createdBy: "system", createdAt: this.clock().toISOString(),
              ...(contentType ? { contentType } : {}),
            };
            await this.store.putFile(file, content);
            return { fileId: file.id, bytes: content.byteLength };
          },
        },
        egressPolicy: this.egressPolicy,
        ...(this.sqlDrivers ? { sqlDrivers: this.sqlDrivers } : {}),
      });

      const inputs = await this.loadInputs(organizationId, run.id, claimed.dependsOn);
      const context: TaskContext = {
        organizationId,
        run,
        task: { ...claimed, attempt },
        node,
        definition,
        inputs,
        config,
        connectors,
        schemaRegistry: new SchemaRegistry(this.store),
        sandbox: this.sandbox,
        store: this.store,
        logger: taskLogger,
        log,
        signal: controller.signal,
        now: this.clock(),
      };

      const result = await executorFor(node.type)(context);
      const finishedAt = this.clock();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await this.persistSuccess(context, result, { attempt, startedAt, finishedAt, durationMs, logs });
      metrics.increment("dataflow_tasks_total", { node_type: node.type, state: "SUCCESS" });
      metrics.observe("dataflow_task_duration_seconds", durationMs / 1000, { node_type: node.type });

      const updated = (await this.store.getTask(organizationId, claimed.id))!;
      await this.advanceRun(organizationId, run.id);
      return { task: updated, state: "SUCCESS", durationMs };
    } catch (error) {
      clearInterval(heartbeat);
      if (timeoutTimer) clearTimeout(timeoutTimer);

      const aborted = controller.signal.aborted ? (controller.signal.reason as Error | undefined) : undefined;
      const effective = aborted instanceof TaskFailure ? aborted : (error as Error);
      const errorClass = effective instanceof TaskFailure ? effective.errorClass : classifyError(effective);
      const message = effective?.message ?? String(error);
      log("error", `Task failed: ${message}`, { errorClass });

      const finishedAt = this.clock();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await this.store.appendLogs(logs);
      await this.store.appendAttempt({
        id: newId("att"),
        organizationId,
        taskRunId: claimed.id,
        runId: run.id,
        attempt,
        state: "FAILED",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        workerId: this.workerId,
        error: message,
        errorClass,
      });

      const decision = errorClass === "cancelled"
        ? { retry: false, delaySeconds: 0, reason: "Run was cancelled" }
        : planRetry(node, attempt, errorClass, definition.defaults?.retry);

      if (decision.retry) {
        const scheduledAt = new Date(finishedAt.getTime() + decision.delaySeconds * 1000).toISOString();
        const retrying = await this.store.updateTask(organizationId, claimed.id, {
          state: "RETRYING",
          scheduledAt,
          workerId: null,
          leaseExpiresAt: null,
          error: message,
          errorClass,
          finishedAt: null,
        });
        await this.emitTaskEvent(retrying, "task.retrying", { attempt, delaySeconds: decision.delaySeconds, error: message, errorClass });
        metrics.increment("dataflow_task_retries_total", { node_type: node.type, error_class: errorClass });
        this.logger.warn("Task will retry", { runId: run.id, nodeId: node.id, attempt, delaySeconds: decision.delaySeconds, errorClass });
        return { task: retrying, state: "RETRYING", error: message, errorClass, retryScheduledAt: scheduledAt, durationMs };
      }

      const state: TaskState = errorClass === "cancelled" ? "CANCELLED" : "FAILED";
      const failed = await this.store.updateTask(organizationId, claimed.id, {
        state,
        finishedAt: finishedAt.toISOString(),
        durationMs,
        workerId: null,
        leaseExpiresAt: null,
        error: message,
        errorClass,
      });
      await this.emitTaskEvent(failed, "task.finished", { state, error: message, errorClass, reason: decision.reason });
      metrics.increment("dataflow_tasks_total", { node_type: node.type, state });
      await this.advanceRun(organizationId, run.id);
      return { task: failed, state, error: message, errorClass, durationMs };
    } finally {
      clearInterval(heartbeat);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await connectors?.close().catch(() => undefined);
    }
  }

  private async persistSuccess(
    context: TaskContext,
    result: TaskResult,
    meta: { attempt: number; startedAt: Date; finishedAt: Date; durationMs: number; logs: TaskLogEntry[] },
  ): Promise<void> {
    const { organizationId, run, task, node } = context;

    if (result.batch) {
      const serialized = JSON.stringify(result.batch);
      if (Buffer.byteLength(serialized) > this.maxBatchBytes) {
        throw new TaskFailure(
          `Node "${node.id}" produced ${Math.round(Buffer.byteLength(serialized) / 1024 / 1024)} MB of intermediate data, ` +
          `over the ${Math.round(this.maxBatchBytes / 1024 / 1024)} MB limit. Write to a destination and read it back, or add a limit.`,
          "validation",
        );
      }
      await this.store.putTaskData(organizationId, run.id, node.id, result.batch);
    }

    if (result.qualityResults?.length) {
      await this.persistQuality(context, result.qualityResults);
    }

    if (result.dataset) {
      await this.store.upsertDataset({
        id: newId("ds"),
        organizationId,
        name: result.dataset,
        sourceType: node.type,
        lastUpdatedAt: meta.finishedAt.toISOString(),
        lastRunId: run.id,
        ...(typeof result.output["rowsWritten"] === "number" ? { rowCount: result.output["rowsWritten"] } : {}),
        ...(run.isDemo ? { isDemo: true } : {}),
        createdAt: meta.finishedAt.toISOString(),
      });
    }

    await this.store.appendLogs(meta.logs);
    await this.store.appendAttempt({
      id: newId("att"),
      organizationId,
      taskRunId: task.id,
      runId: run.id,
      attempt: meta.attempt,
      state: "SUCCESS",
      startedAt: meta.startedAt.toISOString(),
      finishedAt: meta.finishedAt.toISOString(),
      durationMs: meta.durationMs,
      workerId: this.workerId,
      output: result.output,
    });

    const output: JsonObject = {
      ...result.output,
      ...(result.selectedPort ? { selectedPort: result.selectedPort } : {}),
      ...(result.blockDownstream ? { blockedDownstream: true, blockReason: result.blockDownstream.reason } : {}),
    };
    const updated = await this.store.updateTask(organizationId, task.id, {
      state: "SUCCESS",
      finishedAt: meta.finishedAt.toISOString(),
      durationMs: meta.durationMs,
      workerId: null,
      leaseExpiresAt: null,
      output,
      error: null,
      errorClass: null,
    });
    await this.emitTaskEvent(updated, "task.finished", { state: "SUCCESS", output });
  }

  private async persistQuality(context: TaskContext, results: readonly QualityResult[]): Promise<void> {
    const now = this.clock().toISOString();
    await this.store.insertQualityResults(
      results.map((result) => ({
        id: newId("qr"),
        organizationId: context.organizationId,
        runId: context.run.id,
        taskRunId: context.task.id,
        pipelineId: context.run.pipelineId,
        ...(context.config["dataset"] ? { dataset: String(context.config["dataset"]) } : {}),
        checkId: result.checkId,
        checkType: result.type,
        ...(result.column ? { column: result.column } : {}),
        status: result.status,
        severity: result.severity,
        expected: result.expected,
        actual: result.actual,
        passedRows: result.passedRows,
        failedRows: result.failedRows,
        totalRows: result.totalRows,
        passRate: result.passRate,
        ...(result.failedSamples.length ? { failedSamples: { samples: result.failedSamples } as JsonObject } : {}),
        message: result.message,
        createdAt: now,
      })),
    );
    await this.store.appendRunEvent({
      organizationId: context.organizationId,
      runId: context.run.id,
      type: "quality",
      payload: {
        taskRunId: context.task.id,
        nodeId: context.node.id,
        passed: results.filter((r) => r.status === "PASSED").length,
        failed: results.filter((r) => r.status !== "PASSED").length,
      },
    });

    const dataset = context.config["dataset"];
    if (typeof dataset === "string" && dataset) {
      const blocking = results.some((r) => r.severity === "error" && r.status !== "PASSED");
      await this.store.upsertDataset({
        id: newId("ds"),
        organizationId: context.organizationId,
        name: dataset,
        qualityStatus: blocking ? "failing" : "passing",
        createdAt: now,
      });
    }
  }

  /**
   * Merges a stored connection's settings into the node config and resolves every
   * secret reference. This is the only place plaintext credentials exist, and they
   * never leave the worker process.
   */
  private async resolveNodeConfig(organizationId: string, node: WorkflowNode, runId: string): Promise<NodeConfig> {
    const definition = getNodeType(node.type);
    let config: NodeConfig = definition ? applyDefaults(definition.fields, node.config ?? {}) : { ...(node.config ?? {}) };

    const connectionId = config["connectionId"];
    if (typeof connectionId === "string" && connectionId) {
      const connection = await this.store.getConnection(organizationId, connectionId);
      if (!connection) {
        throw new TaskFailure(`Connection "${connectionId}" does not exist or is not visible to this organization`, "not_found");
      }
      if (definition?.connectorFamily && connection.family !== definition.connectorFamily) {
        throw new TaskFailure(
          `Connection "${connection.name}" is a ${connection.family} connection but node "${node.id}" needs ${definition.connectorFamily}`,
          "configuration",
        );
      }
      config = {
        ...(connection.config as NodeConfig),
        ...Object.fromEntries(
          Object.entries(connection.secretRefs).map(([key, secret]) => [key, { secretRef: String(secret) }] as const),
        ),
        ...config,
      };
    }

    const resolved = await resolveSecrets(config, { organizationId, provider: this.secrets });
    if (resolved.resolved.length) {
      await this.store.appendAudit({
        id: newId("audit"),
        organizationId,
        actor: this.workerId,
        actorType: "system",
        action: "secret.read",
        resourceType: "secret",
        resourceId: resolved.resolved.join(","),
        result: "success",
        metadata: { runId, nodeId: node.id },
        createdAt: this.clock().toISOString(),
      });
    }
    return resolved.value;
  }

  private async loadInputs(organizationId: string, runId: string, dependsOn: readonly string[]): Promise<Record<string, DataBatch>> {
    const inputs: Record<string, DataBatch> = {};
    for (const nodeId of dependsOn) {
      const stored = (await this.store.getTaskData(organizationId, runId, nodeId)) as DataBatch | null;
      // A dependency that produced no data (a side-effect node) contributes an
      // empty batch rather than being missing, so executors can rely on the key.
      inputs[nodeId] = stored ?? makeBatch([], []);
    }
    return inputs;
  }

  // -------------------------------------------------------------- scheduling

  /**
   * Releases newly-runnable tasks and finalises the run when everything is
   * terminal. Idempotent: safe to call from several workers concurrently.
   */
  async advanceRun(organizationId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(organizationId, runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const version = await this.store.getVersion(organizationId, run.pipelineVersionId);
    const definition = version?.definition;
    const tasks = await this.store.listTasks(organizationId, runId);
    const byNode = new Map(tasks.map((t) => [t.nodeId, t]));
    const now = this.clock();

    if (run.state === "QUEUED" && tasks.some((t) => t.state !== "PENDING" && t.state !== "QUEUED")) {
      await this.store.updateRun(organizationId, runId, { state: "RUNNING", startedAt: run.startedAt ?? now.toISOString() });
      await this.store.appendRunEvent({ organizationId, runId, type: "run.started", payload: {} });
    }

    // Skipping and blocking cascade: a task skipped in this pass may make its own
    // dependents skippable, so keep sweeping until nothing changes.
    let changed = true;
    let sweeps = 0;
    while (changed && sweeps++ <= tasks.length + 1) {
      changed = false;
      for (const task of [...byNode.values()]) {
        if (task.state !== "PENDING") continue;
        const verdict = this.readiness(task, byNode, definition);
        if (verdict === "wait") continue;

        if (verdict === "queue") {
          const queued = await this.store.compareAndSetTaskState(organizationId, task.id, "PENDING", {
            state: "QUEUED",
            scheduledAt: now.toISOString(),
          });
          if (queued) {
            byNode.set(queued.nodeId, queued);
            changed = true;
            await this.emitTaskEvent(queued, "task.queued", {});
          }
          continue;
        }

        const state: TaskState = verdict === "block" ? "BLOCKED" : "SKIPPED";
        const reason = verdict === "block"
          ? blockReasonFrom(task, byNode)
          : "An upstream task did not succeed";
        const updated = await this.store.compareAndSetTaskState(organizationId, task.id, "PENDING", {
          state,
          finishedAt: now.toISOString(),
          error: reason,
        });
        if (updated) {
          byNode.set(updated.nodeId, updated);
          changed = true;
          await this.emitTaskEvent(updated, state === "BLOCKED" ? "task.blocked" : "task.skipped", { reason });
          metrics.increment("dataflow_tasks_total", { node_type: task.nodeType, state });
        }
      }
    }

    const fresh = await this.store.listTasks(organizationId, runId);
    const terminal = fresh.every((t) => ["SUCCESS", "FAILED", "CANCELLED", "SKIPPED", "BLOCKED"].includes(t.state));
    if (!terminal) return (await this.store.getRun(organizationId, runId))!;

    const totals = {
      tasks: fresh.length,
      succeeded: fresh.filter((t) => t.state === "SUCCESS").length,
      failed: fresh.filter((t) => t.state === "FAILED").length,
      skipped: fresh.filter((t) => t.state === "SKIPPED").length,
      blocked: fresh.filter((t) => t.state === "BLOCKED").length,
    };
    const definitionNodes = new Map((definition?.nodes ?? []).map((n) => [n.id, n]));
    const fatal = fresh.filter((t) => t.state === "FAILED" && definitionNodes.get(t.nodeId)?.continueOnFailure !== true);

    // A single cancelled task does not make the run a success: the pipeline did
    // not do what it was asked to. Only an explicit run-level cancellation
    // reports CANCELLED.
    const cancelledTasks = fresh.filter((t) => t.state === "CANCELLED");
    const state: RunState = run.cancellationRequestedAt
      ? "CANCELLED"
      : fatal.length || totals.blocked || cancelledTasks.length
        ? "FAILED"
        : "SUCCESS";

    const finishedAt = now.toISOString();
    const startedAt = run.startedAt ?? run.queuedAt;
    const finished = await this.store.updateRun(organizationId, runId, {
      state,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      totals,
      error: fatal.length
        ? `${fatal.length} task(s) failed: ${fatal.map((t) => t.nodeId).join(", ")}`
        : totals.blocked
          ? `${totals.blocked} task(s) blocked by a quality gate`
          : cancelledTasks.length && !run.cancellationRequestedAt
            ? `${cancelledTasks.length} task(s) were cancelled: ${cancelledTasks.map((t) => t.nodeId).join(", ")}`
            : null,
    });

    await this.store.appendRunEvent({
      organizationId,
      runId,
      type: "run.finished",
      payload: { state, totals, durationMs: finished.durationMs ?? null },
    });
    metrics.increment("dataflow_runs_finished_total", { pipeline: run.pipelineName, state });
    if (finished.durationMs) metrics.observe("dataflow_run_duration_seconds", finished.durationMs / 1000, { pipeline: run.pipelineName });

    // Intermediate batches are only needed while the run is in flight.
    await this.store.deleteRunData(organizationId, runId).catch(() => undefined);
    await detectIncidents(this.store, finished, { now, logger: this.logger }).catch((error) => {
      this.logger.warn("Incident detection failed", { runId, error: (error as Error).message });
    });

    this.logger.info("Run finished", { runId, state, ...totals });
    return finished;
  }

  /** Decides what should happen to a PENDING task given its dependencies. */
  private readiness(
    task: TaskRun,
    byNode: Map<string, TaskRun>,
    definition: WorkflowDefinition | undefined,
  ): "queue" | "wait" | "skip" | "block" {
    const edges = definition?.edges ?? [];
    let allDone = true;

    for (const dependency of task.dependsOn) {
      const upstream = byNode.get(dependency);
      if (!upstream) return "skip";

      if (upstream.state === "BLOCKED" || (upstream.state === "SUCCESS" && upstream.output?.["blockedDownstream"] === true)) {
        return "block";
      }
      if (["FAILED", "CANCELLED", "SKIPPED"].includes(upstream.state)) {
        const node = definition?.nodes.find((n) => n.id === dependency);
        if (upstream.state === "FAILED" && node?.continueOnFailure) continue;
        return "skip";
      }
      if (upstream.state !== "SUCCESS") { allDone = false; continue; }

      // A condition node only releases the branch it selected.
      const selectedPort = upstream.output?.["selectedPort"];
      if (typeof selectedPort === "string") {
        const edge = edges.find((e) => e.from === dependency && e.to === task.nodeId);
        const port = edge?.port ?? "default";
        if (port !== selectedPort) return "skip";
      }
    }
    return allDone ? "queue" : "wait";
  }

  // ------------------------------------------------------------ cancellation

  /**
   * Requests cancellation. Queued tasks are cancelled immediately; running tasks
   * observe the request at their next heartbeat and abort. The run is only marked
   * CANCELLED once every task is terminal, so the UI never shows a cancelled run
   * with a task still writing to a warehouse.
   */
  async cancelRun(organizationId: string, runId: string, actor: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(organizationId, runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(run.state)) return run;

    const now = this.clock().toISOString();
    await this.store.updateRun(organizationId, runId, { cancellationRequestedAt: now, cancellationRequestedBy: actor });
    await this.store.appendRunEvent({ organizationId, runId, type: "run.cancelling", payload: { actor } });

    for (const task of await this.store.listTasks(organizationId, runId)) {
      if (["PENDING", "QUEUED", "RETRYING"].includes(task.state)) {
        const cancelled = await this.store.compareAndSetTaskState(organizationId, task.id, ["PENDING", "QUEUED", "RETRYING"], {
          state: "CANCELLED",
          finishedAt: now,
          error: "Run was cancelled",
        });
        if (cancelled) await this.emitTaskEvent(cancelled, "task.finished", { state: "CANCELLED" });
      }
    }
    metrics.increment("dataflow_runs_cancelled_total", { pipeline: run.pipelineName });
    return this.advanceRun(organizationId, runId);
  }

  /** Cancels one task; downstream tasks are then skipped by `advanceRun`. */
  async cancelTask(organizationId: string, taskRunId: string, actor: string): Promise<TaskRun> {
    const task = await this.store.getTask(organizationId, taskRunId);
    if (!task) throw new Error(`Task ${taskRunId} not found`);
    const now = this.clock().toISOString();
    const cancelled = await this.store.compareAndSetTaskState(
      organizationId,
      taskRunId,
      ["PENDING", "QUEUED", "RETRYING", "RUNNING"],
      { state: "CANCELLED", finishedAt: now, error: `Cancelled by ${actor}`, workerId: null, leaseExpiresAt: null },
    );
    if (!cancelled) return task;
    await this.emitTaskEvent(cancelled, "task.finished", { state: "CANCELLED", actor });
    await this.advanceRun(organizationId, task.runId);
    return cancelled;
  }

  // ------------------------------------------------------------------ retries

  /**
   * Re-runs a finished run. By default only the nodes that did not succeed (and
   * everything downstream of them) are re-executed; the rest is marked SKIPPED so
   * the run page shows what was actually re-done.
   */
  async retryRun(
    organizationId: string,
    runId: string,
    actor: string,
    options: { fromNodes?: string[]; allNodes?: boolean } = {},
  ): Promise<WorkflowRun> {
    const previous = await this.store.getRun(organizationId, runId);
    if (!previous) throw new Error(`Run ${runId} not found`);
    const version = await this.store.getVersion(organizationId, previous.pipelineVersionId);
    if (!version) throw new Error(`Pipeline version ${previous.pipelineVersionId} not found`);

    let onlyNodes: string[] | undefined;
    if (!options.allNodes) {
      const tasks = await this.store.listTasks(organizationId, runId);
      const failedNodes = options.fromNodes ?? tasks.filter((t) => t.state !== "SUCCESS").map((t) => t.nodeId);
      const index = buildIndex(version.definition);
      const selected = new Set<string>();
      // Walk both ways: downstream because those results are now invalid, and
      // upstream because a re-run needs its inputs and the previous run's
      // intermediate data has already been released.
      for (const direction of ["downstream", "upstream"] as const) {
        const stack = [...failedNodes];
        while (stack.length) {
          const node = stack.pop()!;
          const key = `${direction}:${node}`;
          if (selected.has(node) && stack.length === 0 && key) { /* continue below */ }
          if (!selected.has(node)) selected.add(node);
          for (const next of index[direction].get(node) ?? []) {
            if (!selected.has(next)) { selected.add(next); stack.push(next); }
          }
        }
      }
      onlyNodes = [...selected];
    }

    return this.startRun({
      organizationId,
      pipelineId: previous.pipelineId,
      pipelineName: previous.pipelineName,
      pipelineVersionId: previous.pipelineVersionId,
      version: previous.version,
      definition: version.definition,
      trigger: "retry",
      triggeredBy: actor,
      retryOfRunId: runId,
      ...(previous.params ? { params: previous.params as Record<string, unknown> } : {}),
      ...(previous.logicalDate ? { logicalDate: previous.logicalDate } : {}),
      ...(previous.isDemo ? { isDemo: true } : {}),
      ...(onlyNodes ? { onlyNodes } : {}),
    });
  }

  // ------------------------------------------------------------- inline driver

  /**
   * Drains a run to completion in this process. The worker uses the same claim
   * loop; this exists so `pnpm dev`, the CLI and the tests can execute a pipeline
   * without a separate worker.
   */
  async executeRunToCompletion(
    organizationId: string,
    runId: string,
    options: { maxTasks?: number; onTask?: (outcome: TaskOutcome) => void } = {},
  ): Promise<WorkflowRun> {
    const maxTasks = options.maxTasks ?? 1000;
    for (let executed = 0; executed < maxTasks; executed++) {
      const run = await this.store.getRun(organizationId, runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (["SUCCESS", "FAILED", "CANCELLED"].includes(run.state)) return run;

      const tasks = await this.store.listTasks(organizationId, runId);
      const ready = tasks
        .filter((t) => t.state === "QUEUED" || t.state === "RETRYING")
        .sort((a, b) => b.priority - a.priority || a.scheduledAt.localeCompare(b.scheduledAt));

      if (!ready.length) {
        const advanced = await this.advanceRun(organizationId, runId);
        if (["SUCCESS", "FAILED", "CANCELLED"].includes(advanced.state)) return advanced;
        const stillReady = (await this.store.listTasks(organizationId, runId)).some((t) => ["QUEUED", "RETRYING"].includes(t.state));
        if (!stillReady) {
          throw new Error(`Run ${runId} is stuck: no runnable tasks and the run is not terminal`);
        }
        continue;
      }

      const next = ready[0]!;
      const claimed = await this.store.compareAndSetTaskState(organizationId, next.id, ["QUEUED", "RETRYING"], {
        state: "RUNNING",
        workerId: this.workerId,
        leaseExpiresAt: new Date(this.clock().getTime() + this.leaseSeconds * 1000).toISOString(),
      });
      if (!claimed) continue;
      const outcome = await this.runTask(claimed);
      options.onTask?.(outcome);
    }
    throw new Error(`Run ${runId} did not finish within ${maxTasks} task executions`);
  }

  private async emitTaskEvent(task: TaskRun, type: "task.queued" | "task.started" | "task.finished" | "task.retrying" | "task.blocked" | "task.skipped", payload: JsonObject): Promise<void> {
    await this.store.appendRunEvent({
      organizationId: task.organizationId,
      runId: task.runId,
      type,
      payload: { taskRunId: task.id, nodeId: task.nodeId, nodeType: task.nodeType, state: task.state, attempt: task.attempt, ...payload },
    });
  }

  private async failTask(task: TaskRun, message: string, errorClass: string, startedAt: Date): Promise<TaskOutcome> {
    const now = this.clock();
    const failed = await this.store.updateTask(task.organizationId, task.id, {
      state: "FAILED",
      finishedAt: now.toISOString(),
      durationMs: now.getTime() - startedAt.getTime(),
      workerId: null,
      leaseExpiresAt: null,
      error: message,
      errorClass,
    });
    await this.emitTaskEvent(failed, "task.finished", { state: "FAILED", error: message, errorClass });
    return { task: failed, state: "FAILED", error: message, errorClass, durationMs: now.getTime() - startedAt.getTime() };
  }
}

function blockReasonFrom(task: TaskRun, byNode: Map<string, TaskRun>): string {
  for (const dependency of task.dependsOn) {
    const upstream = byNode.get(dependency);
    const reason = upstream?.output?.["blockReason"];
    if (typeof reason === "string") return reason;
    if (upstream?.state === "BLOCKED") return upstream.error ?? "Blocked by an upstream quality gate";
  }
  return "Blocked by an upstream quality gate";
}

export type { TaskAttempt };
