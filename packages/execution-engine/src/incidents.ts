import type { Incident, IncidentKind, Store, WorkflowRun } from "@dataflow-studio/database";
import { Logger, newId, rootLogger } from "@dataflow-studio/observability";
import type { JsonObject } from "@dataflow-studio/workflow-engine";

export interface DetectOptions {
  now?: Date;
  logger?: Logger;
  /** Consecutive failures before an incident is opened. */
  failureThreshold?: number;
  /** Duration multiple over the recent average that counts as a spike. */
  spikeMultiplier?: number;
  /** Ignore spikes on runs shorter than this. */
  spikeFloorMs?: number;
}

/**
 * Opens incidents from what actually happened in a run.
 *
 * Every rule is a deterministic comparison against stored records, and the
 * evidence attached to an incident is the same data the rule used - counts, run
 * ids, timestamps. Nothing is inferred, and no rule speculates about a cause.
 */
export async function detectIncidents(
  store: Store,
  run: WorkflowRun,
  options: DetectOptions = {},
): Promise<Incident[]> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? rootLogger;
  const failureThreshold = options.failureThreshold ?? 3;
  const spikeMultiplier = options.spikeMultiplier ?? 2;
  const spikeFloorMs = options.spikeFloorMs ?? 30_000;
  const opened: Incident[] = [];

  const open = async (input: {
    kind: IncidentKind;
    severity: Incident["severity"];
    title: string;
    evidence: JsonObject;
    fingerprint: string;
    dataset?: string;
  }): Promise<void> => {
    const existing = await store.getIncidentByFingerprint(run.organizationId, input.fingerprint);
    const incident = await store.upsertIncident({
      id: existing?.id ?? newId("inc"),
      organizationId: run.organizationId,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      evidence: input.evidence,
      pipelineId: run.pipelineId,
      runId: run.id,
      ...(input.dataset ? { dataset: input.dataset } : {}),
      status: existing?.status === "acknowledged" ? "acknowledged" : "open",
      fingerprint: input.fingerprint,
      occurrences: (existing?.occurrences ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
    });
    opened.push(incident);
    logger.warn("Incident recorded", { kind: incident.kind, fingerprint: incident.fingerprint, occurrences: incident.occurrences });
  };

  // ------------------------------------------------- repeated pipeline failure
  if (run.state === "FAILED") {
    const recent = await store.listRuns(run.organizationId, { pipelineId: run.pipelineId, limit: failureThreshold });
    const consecutive = takeWhileFailed(recent.items);
    if (consecutive.length >= failureThreshold) {
      await open({
        kind: "repeated_failure",
        severity: "high",
        title: `${run.pipelineName} failed ${consecutive.length} consecutive times`,
        fingerprint: `repeated_failure:${run.pipelineId}`,
        evidence: {
          consecutiveFailures: consecutive.length,
          runIds: consecutive.map((r) => r.id),
          firstFailureAt: consecutive.at(-1)?.queuedAt ?? run.queuedAt,
          lastError: run.error ?? null,
        },
      });
    }
  }

  // ------------------------------------------------------------ duration spike
  if (run.state === "SUCCESS" && typeof run.durationMs === "number" && run.durationMs > spikeFloorMs) {
    const history = await store.listRuns(run.organizationId, { pipelineId: run.pipelineId, state: "SUCCESS", limit: 20 });
    const durations = history.items
      .filter((r) => r.id !== run.id && typeof r.durationMs === "number")
      .map((r) => r.durationMs as number);
    if (durations.length >= 5) {
      const average = durations.reduce((a, b) => a + b, 0) / durations.length;
      if (run.durationMs > average * spikeMultiplier) {
        await open({
          kind: "duration_spike",
          severity: "medium",
          title: `${run.pipelineName} took ${(run.durationMs / 1000).toFixed(1)}s, ${(run.durationMs / average).toFixed(1)}x its recent average`,
          fingerprint: `duration_spike:${run.pipelineId}`,
          evidence: {
            durationMs: run.durationMs,
            recentAverageMs: Math.round(average),
            sampleSize: durations.length,
            multiplier: Number((run.durationMs / average).toFixed(2)),
          },
        });
      }
    }
  }

  // ------------------------------------------------------------ quality and data
  const qualityResults = await store.listQualityResults(run.organizationId, { runId: run.id, limit: 500 });
  const failing = qualityResults.filter((r) => r.status !== "PASSED");
  if (failing.length) {
    const byDataset = new Map<string, typeof failing>();
    for (const result of failing) {
      const key = result.dataset ?? "(unnamed dataset)";
      byDataset.set(key, [...(byDataset.get(key) ?? []), result]);
    }
    for (const [dataset, results] of byDataset) {
      await open({
        kind: "quality_failure",
        severity: results.some((r) => r.severity === "error") ? "high" : "low",
        title: `${results.length} data quality check(s) failed on ${dataset}`,
        fingerprint: `quality_failure:${run.pipelineId}:${dataset}`,
        dataset,
        evidence: {
          checks: results.map((r) => ({ checkId: r.checkId, column: r.column ?? null, expected: r.expected, actual: r.actual, failedRows: r.failedRows, totalRows: r.totalRows })),
          runId: run.id,
        },
      });
    }
  }

  const tasks = await store.listTasks(run.organizationId, run.id);

  // --------------------------------------------------------------- schema drift
  for (const task of tasks) {
    const classification = task.output?.["classification"];
    if (task.nodeType !== "schema.validate" || typeof classification !== "string" || classification === "COMPATIBLE") continue;
    const dataset = typeof task.output?.["dataset"] === "string" ? task.output["dataset"] : undefined;
    await open({
      kind: "schema_change",
      severity: classification === "BREAKING" ? "high" : "medium",
      title: `${classification} schema change detected on ${dataset ?? task.nodeId}`,
      fingerprint: `schema_change:${run.pipelineId}:${dataset ?? task.nodeId}`,
      ...(dataset ? { dataset } : {}),
      evidence: {
        classification,
        changes: task.output?.["changes"] ?? null,
        nodeId: task.nodeId,
        runId: run.id,
      },
    });
  }

  // ---------------------------------------------------------------- missing data
  for (const task of tasks) {
    const rowsRead = task.output?.["rowsRead"];
    if (task.state !== "SUCCESS" || typeof rowsRead !== "number" || rowsRead > 0) continue;
    // Only an incident if this source has produced rows before: a brand-new
    // pipeline reading zero rows is not yet evidence of anything.
    const history = await store.listRuns(run.organizationId, { pipelineId: run.pipelineId, state: "SUCCESS", limit: 5 });
    let sawData = false;
    for (const previous of history.items) {
      if (previous.id === run.id) continue;
      const previousTasks = await store.listTasks(run.organizationId, previous.id);
      const same = previousTasks.find((t) => t.nodeId === task.nodeId);
      if (typeof same?.output?.["rowsRead"] === "number" && (same.output["rowsRead"] as number) > 0) { sawData = true; break; }
    }
    if (!sawData) continue;
    await open({
      kind: "missing_data",
      severity: "medium",
      title: `${task.nodeId} read 0 rows in ${run.pipelineName}`,
      fingerprint: `missing_data:${run.pipelineId}:${task.nodeId}`,
      evidence: { nodeId: task.nodeId, nodeType: task.nodeType, rowsRead: 0, runId: run.id },
    });
  }

  return opened;
}

function takeWhileFailed(runs: readonly WorkflowRun[]): WorkflowRun[] {
  const out: WorkflowRun[] = [];
  for (const run of runs) {
    if (run.state === "FAILED") out.push(run);
    else if (run.state === "SUCCESS" || run.state === "CANCELLED") break;
  }
  return out;
}

export interface StaleDatasetOptions {
  now?: Date;
  /** A dataset is stale when it is older than this multiple of its schedule interval. */
  tolerance?: number;
}

/**
 * Finds datasets that a schedule should have refreshed but did not. Run on a
 * timer by the worker rather than per-run, because staleness is the absence of
 * an event.
 */
export async function detectStaleDatasets(
  store: Store,
  organizationId: string,
  options: StaleDatasetOptions = {},
): Promise<Incident[]> {
  const now = options.now ?? new Date();
  const tolerance = options.tolerance ?? 2;
  const opened: Incident[] = [];

  const schedules = await store.listSchedules(organizationId);
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const intervalSeconds = schedule.intervalSeconds ?? 86_400;
    const datasets = await store.listDatasets(organizationId, { limit: 200 });

    for (const dataset of datasets.items) {
      if (!dataset.lastUpdatedAt || !dataset.lastRunId) continue;
      const lastRun = await store.getRun(organizationId, dataset.lastRunId);
      if (lastRun?.pipelineId !== schedule.pipelineId) continue;

      const ageSeconds = (now.getTime() - new Date(dataset.lastUpdatedAt).getTime()) / 1000;
      if (ageSeconds <= intervalSeconds * tolerance) continue;

      const fingerprint = `stale_dataset:${dataset.name}`;
      const existing = await store.getIncidentByFingerprint(organizationId, fingerprint);
      opened.push(await store.upsertIncident({
        id: existing?.id ?? newId("inc"),
        organizationId,
        kind: "stale_dataset",
        severity: "medium",
        title: `${dataset.name} has not been refreshed for ${Math.round(ageSeconds / 3600)}h`,
        evidence: {
          dataset: dataset.name,
          lastUpdatedAt: dataset.lastUpdatedAt,
          expectedEverySeconds: intervalSeconds,
          ageSeconds: Math.round(ageSeconds),
          scheduleId: schedule.id,
        },
        pipelineId: schedule.pipelineId,
        dataset: dataset.name,
        status: existing?.status === "acknowledged" ? "acknowledged" : "open",
        fingerprint,
        occurrences: (existing?.occurrences ?? 0) + 1,
        firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
        lastSeenAt: now.toISOString(),
      }));
    }
  }
  return opened;
}
