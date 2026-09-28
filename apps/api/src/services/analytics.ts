import type { RunAnalytics } from "@dataflow-studio/database";
import { authorize, type ApiContext } from "../context.js";

export interface DashboardSummary {
  pipelines: { total: number; active: number; scheduled: number };
  runs: { running: number; queued: number; succeeded: number; failed: number; total: number };
  performance: { averageDurationMs: number | null; p95DurationMs: number | null; successRate: number };
  quality: { failures: number };
  incidents: { open: number };
  recentRuns: Awaited<ReturnType<ApiContext["store"]["listRuns"]>>["items"];
  recentIncidents: Awaited<ReturnType<ApiContext["store"]["listIncidents"]>>["items"];
  upcomingSchedules: Awaited<ReturnType<ApiContext["store"]["listSchedules"]>>;
  analytics: RunAnalytics;
  /** True when the organization contains only demo data. */
  demoOnly: boolean;
  /** Reported so the UI can warn that in-memory state is not durable. */
  storeDriver: "memory" | "postgres";
}

const DAY_MS = 86_400_000;

/**
 * Every number here is computed from stored execution records. There is no
 * placeholder data path: an empty organization reports zeros, which is what the
 * dashboard then says.
 */
export async function getDashboard(context: ApiContext, options: { days?: number } = {}): Promise<DashboardSummary> {
  authorize(context, "analytics.read");
  const organizationId = context.principal.organizationId;
  const days = Math.min(Math.max(options.days ?? 14, 1), 90);
  const to = context.now.toISOString();
  const from = new Date(context.now.getTime() - days * DAY_MS).toISOString();

  const [pipelines, runStates, recentRuns, incidents, schedules, analytics] = await Promise.all([
    context.store.listPipelines(organizationId, { limit: 200 }),
    context.store.countRunsByState(organizationId),
    context.store.listRuns(organizationId, { limit: 10 }),
    context.store.listIncidents(organizationId, { status: "open", limit: 5 }),
    context.store.listSchedules(organizationId),
    context.store.runAnalytics(organizationId, { from, to }),
  ]);

  const activePipelineIds = new Set(
    (await context.store.listRuns(organizationId, { since: from, limit: 200 })).items.map((r) => r.pipelineId),
  );

  return {
    pipelines: {
      total: pipelines.items.length,
      active: pipelines.items.filter((p) => activePipelineIds.has(p.id)).length,
      scheduled: new Set(schedules.filter((s) => s.enabled).map((s) => s.pipelineId)).size,
    },
    runs: {
      running: runStates.RUNNING,
      queued: runStates.QUEUED,
      succeeded: runStates.SUCCESS,
      failed: runStates.FAILED,
      total: Object.values(runStates).reduce((a, b) => a + b, 0),
    },
    performance: {
      averageDurationMs: analytics.averageDurationMs,
      p95DurationMs: analytics.p95DurationMs,
      successRate: analytics.successRate,
    },
    quality: { failures: analytics.qualityFailures },
    incidents: { open: incidents.items.length },
    recentRuns: recentRuns.items,
    recentIncidents: incidents.items,
    upcomingSchedules: schedules.filter((s) => s.enabled).slice(0, 5),
    analytics,
    demoOnly: pipelines.items.length > 0 && pipelines.items.every((p) => p.isDemo === true),
    storeDriver: context.store.driver,
  };
}

export async function getAnalytics(
  context: ApiContext,
  options: { from?: string; to?: string; pipelineId?: string } = {},
): Promise<RunAnalytics> {
  authorize(context, "analytics.read");
  const to = options.to ?? context.now.toISOString();
  const from = options.from ?? new Date(context.now.getTime() - 30 * DAY_MS).toISOString();
  return context.store.runAnalytics(context.principal.organizationId, {
    from,
    to,
    ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
  });
}

export async function listAudit(
  context: ApiContext,
  filter: { action?: string; resourceType?: string; actor?: string; limit?: number; cursor?: string } = {},
): Promise<Awaited<ReturnType<ApiContext["store"]["listAudit"]>>> {
  authorize(context, "audit.read");
  return context.store.listAudit(context.principal.organizationId, filter);
}
