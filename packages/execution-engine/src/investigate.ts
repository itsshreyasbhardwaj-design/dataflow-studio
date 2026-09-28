import type { Store, TaskAttempt, TaskLogEntry, TaskRun, WorkflowRun } from "@dataflow-studio/database";
import { diffWorkflows, type WorkflowDiff } from "@dataflow-studio/workflow-engine";
import type { QualityResultRecord } from "@dataflow-studio/database";

export interface FailureEvidence {
  run: WorkflowRun;
  /** The first task that failed, which is usually the interesting one. */
  failedTask: TaskRun | null;
  attempts: TaskAttempt[];
  /** Log lines around the failure, error level first. */
  logs: TaskLogEntry[];
  /** Comparison against the most recent successful run of the same pipeline. */
  lastSuccessfulRun: WorkflowRun | null;
  /** What changed in the definition since that successful run, if the version changed. */
  versionDiff: WorkflowDiff | null;
  qualityFailures: QualityResultRecord[];
  /** Tasks blocked as a consequence, so the blast radius is visible. */
  affectedTasks: TaskRun[];
  /** Same-node failures in recent runs, for "is this new?" */
  recurrence: { runs: number; sinceFirstFailure: string | null };
}

/**
 * Collects the evidence a human needs to diagnose a failed run.
 *
 * This is deliberately a retrieval function, not an analysis one: it gathers
 * facts (which task failed, on which attempt, what it logged, what changed since
 * the last success) and leaves interpretation to the reader - or to the optional
 * AI assistant, which is given exactly this payload and nothing else.
 */
export async function gatherFailureEvidence(
  store: Store,
  organizationId: string,
  runId: string,
  options: { logLimit?: number } = {},
): Promise<FailureEvidence> {
  const run = await store.getRun(organizationId, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const tasks = await store.listTasks(organizationId, runId);
  const failedTask = tasks
    .filter((t) => t.state === "FAILED")
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))[0] ?? null;

  const attempts = failedTask ? await store.listAttempts(organizationId, failedTask.id) : [];

  const errorLogs = failedTask
    ? (await store.listLogs(organizationId, runId, { taskRunId: failedTask.id, level: "error", limit: options.logLimit ?? 50 })).items
    : [];
  const contextLogs = failedTask
    ? (await store.listLogs(organizationId, runId, { taskRunId: failedTask.id, limit: options.logLimit ?? 50 })).items
    : [];

  const history = await store.listRuns(organizationId, { pipelineId: run.pipelineId, state: "SUCCESS", limit: 1 });
  const lastSuccessfulRun = history.items[0] ?? null;

  let versionDiff: WorkflowDiff | null = null;
  if (lastSuccessfulRun && lastSuccessfulRun.pipelineVersionId !== run.pipelineVersionId) {
    const [before, after] = await Promise.all([
      store.getVersion(organizationId, lastSuccessfulRun.pipelineVersionId),
      store.getVersion(organizationId, run.pipelineVersionId),
    ]);
    if (before && after) versionDiff = diffWorkflows(before.definition, after.definition);
  }

  const qualityFailures = (await store.listQualityResults(organizationId, { runId, limit: 200 }))
    .filter((r) => r.status !== "PASSED");

  const affectedTasks = tasks.filter((t) => t.state === "BLOCKED" || t.state === "SKIPPED");

  let recurrence = { runs: 0, sinceFirstFailure: null as string | null };
  if (failedTask) {
    const recent = await store.listRuns(organizationId, { pipelineId: run.pipelineId, limit: 20 });
    let count = 0;
    let earliest: string | null = null;
    for (const candidate of recent.items) {
      const candidateTasks = await store.listTasks(organizationId, candidate.id);
      const same = candidateTasks.find((t) => t.nodeId === failedTask.nodeId && t.state === "FAILED");
      if (same) { count++; earliest = candidate.queuedAt; }
    }
    recurrence = { runs: count, sinceFirstFailure: earliest };
  }

  return {
    run,
    failedTask,
    attempts,
    logs: dedupeLogs([...errorLogs, ...contextLogs]),
    lastSuccessfulRun,
    versionDiff,
    qualityFailures,
    affectedTasks,
    recurrence,
  };
}

function dedupeLogs(entries: readonly TaskLogEntry[]): TaskLogEntry[] {
  const seen = new Set<string>();
  const out: TaskLogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
