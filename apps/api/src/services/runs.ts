import type { QualityResultRecord, RunEvent, TaskAttempt, TaskLogEntry, TaskRun, WorkflowRun } from "@dataflow-studio/database";
import { gatherFailureEvidence, type FailureEvidence } from "@dataflow-studio/execution-engine";
import { maskConfig } from "@dataflow-studio/secrets";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

export async function listRuns(
  context: ApiContext,
  filter: {
    pipelineId?: string; state?: string | string[]; trigger?: string; backfillId?: string;
    scheduleId?: string; since?: string; until?: string; limit?: number; cursor?: string;
    sort?: "queued_at" | "duration"; direction?: "asc" | "desc";
  } = {},
): Promise<{ items: WorkflowRun[]; nextCursor?: string; total?: number }> {
  authorize(context, "pipeline.read");
  const page = await context.store.listRuns(context.principal.organizationId, filter as never);
  return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.total !== undefined ? { total: page.total } : {}) };
}

export interface RunDetail {
  run: WorkflowRun;
  tasks: TaskRun[];
  /** Graph shape so the run page can draw the DAG without fetching the version. */
  graph: { nodes: Array<{ id: string; type: string; label: string; position?: { x: number; y: number } }>; edges: Array<{ from: string; to: string; port?: string }> };
  quality: QualityResultRecord[];
  events: RunEvent[];
}

export async function getRun(context: ApiContext, runId: string): Promise<RunDetail> {
  authorize(context, "pipeline.read");
  const organizationId = context.principal.organizationId;
  const run = await context.store.getRun(organizationId, runId);
  if (!run) throw ApiError.notFound("Run", runId);

  const [tasks, version, quality, events] = await Promise.all([
    context.store.listTasks(organizationId, runId),
    context.store.getVersion(organizationId, run.pipelineVersionId),
    context.store.listQualityResults(organizationId, { runId, limit: 500 }),
    context.store.listRunEvents(organizationId, runId),
  ]);

  const graph = {
    nodes: (version?.definition.nodes ?? []).map((node) => ({
      id: node.id,
      type: node.type,
      label: (node.metadata?.label as string | undefined) ?? node.id,
      ...(node.metadata?.position ? { position: node.metadata.position as { x: number; y: number } } : {}),
    })),
    edges: (version?.definition.edges ?? []).map((edge) => ({ from: edge.from, to: edge.to, ...(edge.port ? { port: edge.port } : {}) })),
  };

  return { run, tasks, graph, quality, events };
}

export interface TaskDetail {
  task: TaskRun;
  attempts: TaskAttempt[];
  logs: TaskLogEntry[];
  /** Node configuration with secret references masked. */
  config: Record<string, unknown>;
  nodeType: string;
  inputs: string[];
  quality: QualityResultRecord[];
}

export async function getTask(context: ApiContext, runId: string, taskRunId: string): Promise<TaskDetail> {
  authorize(context, "pipeline.read");
  const organizationId = context.principal.organizationId;
  const task = await context.store.getTask(organizationId, taskRunId);
  if (!task || task.runId !== runId) throw ApiError.notFound("Task", taskRunId);

  const run = await context.store.getRun(organizationId, runId);
  const version = run ? await context.store.getVersion(organizationId, run.pipelineVersionId) : null;
  const node = version?.definition.nodes.find((n) => n.id === task.nodeId);

  const [attempts, logs, quality] = await Promise.all([
    context.store.listAttempts(organizationId, taskRunId),
    context.store.listLogs(organizationId, runId, { taskRunId, limit: 200 }),
    context.store.listQualityResults(organizationId, { runId, limit: 500 }),
  ]);

  return {
    task,
    attempts,
    logs: logs.items,
    config: node ? (maskConfig(node.config ?? {}) as Record<string, unknown>) : {},
    nodeType: task.nodeType,
    inputs: task.dependsOn,
    quality: quality.filter((q) => q.taskRunId === taskRunId),
  };
}

export async function listRunLogs(
  context: ApiContext,
  runId: string,
  filter: { taskRunId?: string; attempt?: number; level?: "debug" | "info" | "warn" | "error"; search?: string; since?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: TaskLogEntry[]; nextCursor?: string }> {
  authorize(context, "pipeline.read");
  const run = await context.store.getRun(context.principal.organizationId, runId);
  if (!run) throw ApiError.notFound("Run", runId);
  const page = await context.store.listLogs(context.principal.organizationId, runId, filter);
  return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export async function cancelRun(context: ApiContext, runId: string): Promise<WorkflowRun> {
  authorize(context, "pipeline.cancel");
  const run = await context.store.getRun(context.principal.organizationId, runId);
  if (!run) throw ApiError.notFound("Run", runId);

  return audited(context, { action: "run.cancel", resourceType: "run", resourceId: runId }, async () =>
    context.engine.cancelRun(context.principal.organizationId, runId, context.principal.userId),
  );
}

export async function cancelTask(context: ApiContext, runId: string, taskRunId: string): Promise<TaskRun> {
  authorize(context, "pipeline.cancel");
  const task = await context.store.getTask(context.principal.organizationId, taskRunId);
  if (!task || task.runId !== runId) throw ApiError.notFound("Task", taskRunId);

  return audited(context, { action: "task.cancel", resourceType: "task", resourceId: taskRunId }, async () =>
    context.engine.cancelTask(context.principal.organizationId, taskRunId, context.principal.userId),
  );
}

export async function retryRun(
  context: ApiContext,
  runId: string,
  options: { fromNodes?: string[]; allNodes?: boolean } = {},
): Promise<WorkflowRun> {
  authorize(context, "pipeline.execute");
  const run = await context.store.getRun(context.principal.organizationId, runId);
  if (!run) throw ApiError.notFound("Run", runId);
  if (!["FAILED", "CANCELLED", "SUCCESS"].includes(run.state)) {
    throw ApiError.conflict(`Run is ${run.state}; wait for it to finish before retrying`);
  }

  return audited(
    context,
    { action: "run.retry", resourceType: "run", resourceId: runId, metadata: { allNodes: options.allNodes ?? false } },
    async () => context.engine.retryRun(context.principal.organizationId, runId, context.principal.userId, options),
  );
}

export async function investigateRun(context: ApiContext, runId: string): Promise<FailureEvidence> {
  authorize(context, "pipeline.read");
  return gatherFailureEvidence(context.store, context.principal.organizationId, runId);
}

/**
 * Server-sent events for a live run. Replays anything the client missed using the
 * `Last-Event-ID` sequence, then streams new events, so a reconnect does not lose
 * state and the client never polls the database.
 */
export function streamRunEvents(
  context: ApiContext,
  runId: string,
  options: { lastEventId?: number; pollMs?: number; signal?: AbortSignal; maxDurationMs?: number } = {},
): Response {
  authorize(context, "pipeline.read");
  const organizationId = context.principal.organizationId;
  const pollMs = options.pollMs ?? 1000;
  const maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
  const encoder = new TextEncoder();
  const store = context.store;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSequence = options.lastEventId ?? 0;
      const startedAt = Date.now();
      let closed = false;

      const send = (event: { id?: number; type: string; data: unknown }): void => {
        if (closed) return;
        const lines = [
          ...(event.id !== undefined ? [`id: ${event.id}`] : []),
          `event: ${event.type}`,
          `data: ${JSON.stringify(event.data)}`,
          "",
          "",
        ];
        controller.enqueue(encoder.encode(lines.join("\n")));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      };

      const tick = async (): Promise<void> => {
        try {
          const events = await store.listRunEvents(organizationId, runId, lastSequence);
          for (const event of events) {
            lastSequence = event.sequence;
            send({ id: event.sequence, type: event.type, data: event.payload });
          }
          const run = await store.getRun(organizationId, runId);
          if (!run) { send({ type: "error", data: { message: "Run not found" } }); close(); return; }
          if (["SUCCESS", "FAILED", "CANCELLED"].includes(run.state)) {
            send({ type: "run.state", data: { state: run.state, durationMs: run.durationMs ?? null, totals: run.totals ?? null } });
            close();
            return;
          }
          if (Date.now() - startedAt > maxDurationMs) {
            send({ type: "timeout", data: { message: "Stream duration limit reached; reconnect to continue" } });
            close();
          }
        } catch (error) {
          send({ type: "error", data: { message: (error as Error).message } });
          close();
        }
      };

      const timer = setInterval(() => void tick(), pollMs);
      options.signal?.addEventListener("abort", close, { once: true });
      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
