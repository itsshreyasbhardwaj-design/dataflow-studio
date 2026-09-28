import { newId } from "@dataflow-studio/observability";
import type { TaskRun, WorkflowRun } from "@dataflow-studio/database";
import {
  buildIndex, getNodeType, resolveRetryPolicy, topologicalLayers,
  type TriggerType, type WorkflowDefinition,
} from "@dataflow-studio/workflow-engine";

export interface PlanRunInput {
  organizationId: string;
  pipelineId: string;
  pipelineName: string;
  pipelineVersionId: string;
  version: number;
  definition: WorkflowDefinition;
  trigger: TriggerType;
  triggeredBy: string;
  params?: Record<string, unknown>;
  logicalDate?: string;
  scheduleId?: string;
  backfillId?: string;
  retryOfRunId?: string;
  requestId?: string;
  isDemo?: boolean;
  now?: Date;
  /** Only these nodes run; their dependencies are marked SKIPPED. Used by "retry from here". */
  onlyNodes?: string[];
}

export interface PlannedRun {
  run: WorkflowRun;
  tasks: TaskRun[];
}

/**
 * Turns a workflow definition into a run and its task rows.
 *
 * Root tasks start QUEUED so a worker can claim them immediately; everything else
 * starts PENDING and is released by the engine as its dependencies succeed. The
 * dependency list is denormalized onto each task so the engine can decide
 * readiness without re-reading the definition.
 */
export function planRun(input: PlanRunInput): PlannedRun {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const runId = newId("run");
  const index = buildIndex(input.definition);
  // Throws on a cyclic graph; callers validate first, this is the safety net.
  const layers = topologicalLayers(index);
  const priorityOf = (nodeId: string): number => {
    const layer = layers.findIndex((l) => l.includes(nodeId));
    // Earlier layers first: higher priority number is claimed first.
    return Math.max(0, layers.length - layer);
  };

  const selected = input.onlyNodes ? new Set(input.onlyNodes) : null;

  const tasks: TaskRun[] = input.definition.nodes.map((node) => {
    const dependsOn = (index.upstream.get(node.id) ?? []).slice().sort();
    const retry = resolveRetryPolicy(node, input.definition.defaults?.retry);
    const included = !selected || selected.has(node.id);
    return {
      id: newId("task"),
      organizationId: input.organizationId,
      runId,
      pipelineId: input.pipelineId,
      nodeId: node.id,
      nodeType: node.type,
      state: !included ? "SKIPPED" : dependsOn.length === 0 ? "QUEUED" : "PENDING",
      attempt: 0,
      maxAttempts: retry.maxAttempts,
      scheduledAt: nowIso,
      dependsOn,
      priority: priorityOf(node.id),
      ...(included ? {} : { finishedAt: nowIso, error: "Not selected for this run" }),
    };
  });

  const run: WorkflowRun = {
    id: runId,
    organizationId: input.organizationId,
    pipelineId: input.pipelineId,
    pipelineVersionId: input.pipelineVersionId,
    pipelineName: input.pipelineName,
    version: input.version,
    state: "QUEUED",
    trigger: input.trigger,
    triggeredBy: input.triggeredBy,
    queuedAt: nowIso,
    ...(input.params ? { params: input.params as WorkflowRun["params"] } : {}),
    ...(input.logicalDate ? { logicalDate: input.logicalDate } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.backfillId ? { backfillId: input.backfillId } : {}),
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.isDemo ? { isDemo: true } : {}),
    totals: {
      tasks: tasks.length,
      succeeded: 0,
      failed: 0,
      skipped: tasks.filter((t) => t.state === "SKIPPED").length,
      blocked: 0,
    },
  };

  return { run, tasks };
}

/** Node ids whose declared type is unknown to this worker fleet. */
export function unsupportedNodes(definition: WorkflowDefinition): string[] {
  return definition.nodes.filter((node) => !getNodeType(node.type)).map((node) => node.id);
}
