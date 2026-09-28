import type { Backfill, Schedule } from "@dataflow-studio/database";
import {
  advanceBackfill, backfillProgress, buildSchedule, describeCron, isValidCron,
  nextCronOccurrences, planBackfill, type BackfillProgress,
} from "@dataflow-studio/scheduler";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

export interface ScheduleView extends Schedule {
  description: string;
  upcoming: string[];
}

function decorate(schedule: Schedule): ScheduleView {
  const upcoming = schedule.kind === "cron" && schedule.cron
    ? nextCronOccurrences(schedule.cron, new Date(), schedule.timezone, 3).map((d) => d.toISOString())
    : [schedule.nextRunAt];
  return {
    ...schedule,
    description: schedule.kind === "cron" && schedule.cron
      ? describeCron(schedule.cron, schedule.timezone)
      : `Every ${Math.round((schedule.intervalSeconds ?? 0) / 60)} minutes`,
    upcoming,
  };
}

export async function listSchedules(context: ApiContext, pipelineId?: string): Promise<ScheduleView[]> {
  authorize(context, "pipeline.read");
  const schedules = await context.store.listSchedules(context.principal.organizationId, pipelineId);
  return schedules.map(decorate);
}

export interface CreateScheduleInput {
  pipelineId: string;
  kind: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
  timezone?: string;
  enabled?: boolean;
  catchup?: boolean;
  pipelineVersionId?: string;
}

export async function createSchedule(context: ApiContext, input: CreateScheduleInput): Promise<ScheduleView> {
  authorize(context, "workflow.schedule");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, input.pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", input.pipelineId);
  if (!pipeline.publishedVersionId && !input.pipelineVersionId) {
    throw ApiError.validation("Publish the pipeline before scheduling it, or pin a specific version");
  }
  if (input.kind === "cron" && !isValidCron(input.cron ?? "")) {
    throw ApiError.validation(`"${input.cron ?? ""}" is not a valid cron expression`);
  }

  const schedule = buildSchedule({
    organizationId,
    pipelineId: input.pipelineId,
    ...(input.pipelineVersionId ? { pipelineVersionId: input.pipelineVersionId } : {}),
    kind: input.kind,
    ...(input.cron ? { cron: input.cron } : {}),
    ...(input.intervalSeconds ? { intervalSeconds: input.intervalSeconds } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.catchup !== undefined ? { catchup: input.catchup } : {}),
    createdBy: context.principal.userId,
    now: context.now,
  });

  return audited(
    context,
    { action: "schedule.create", resourceType: "schedule", resourceId: schedule.id, metadata: { pipelineId: input.pipelineId, kind: input.kind } },
    async () => decorate(await context.store.createSchedule(schedule)),
  );
}

export async function updateSchedule(
  context: ApiContext,
  scheduleId: string,
  input: { enabled?: boolean; cron?: string; intervalSeconds?: number; timezone?: string; catchup?: boolean },
): Promise<ScheduleView> {
  authorize(context, "workflow.schedule");
  const organizationId = context.principal.organizationId;
  const existing = await context.store.getSchedule(organizationId, scheduleId);
  if (!existing) throw ApiError.notFound("Schedule", scheduleId);

  // Rebuild rather than patch, so validation and the next firing stay consistent.
  const rebuilt = buildSchedule({
    organizationId,
    pipelineId: existing.pipelineId,
    ...(existing.pipelineVersionId ? { pipelineVersionId: existing.pipelineVersionId } : {}),
    kind: existing.kind,
    ...(input.cron ?? existing.cron ? { cron: input.cron ?? existing.cron } : {}),
    ...(input.intervalSeconds ?? existing.intervalSeconds ? { intervalSeconds: input.intervalSeconds ?? existing.intervalSeconds } : {}),
    timezone: input.timezone ?? existing.timezone,
    enabled: input.enabled ?? existing.enabled,
    catchup: input.catchup ?? existing.catchup,
    createdBy: existing.createdBy,
    now: context.now,
  });

  return audited(context, { action: "schedule.edit", resourceType: "schedule", resourceId: scheduleId }, async () =>
    decorate(await context.store.updateSchedule(organizationId, scheduleId, {
      cron: rebuilt.cron ?? null as never,
      intervalSeconds: rebuilt.intervalSeconds ?? null as never,
      timezone: rebuilt.timezone,
      enabled: rebuilt.enabled,
      catchup: rebuilt.catchup,
      nextRunAt: rebuilt.nextRunAt,
      updatedAt: context.now.toISOString(),
    })),
  );
}

export async function deleteSchedule(context: ApiContext, scheduleId: string): Promise<{ deleted: boolean }> {
  authorize(context, "workflow.schedule");
  const existing = await context.store.getSchedule(context.principal.organizationId, scheduleId);
  if (!existing) throw ApiError.notFound("Schedule", scheduleId);
  return audited(context, { action: "schedule.delete", resourceType: "schedule", resourceId: scheduleId }, async () => ({
    deleted: await context.store.deleteSchedule(context.principal.organizationId, scheduleId),
  }));
}

export async function listBackfills(context: ApiContext, pipelineId?: string): Promise<Backfill[]> {
  authorize(context, "pipeline.read");
  return context.store.listBackfills(context.principal.organizationId, pipelineId);
}

export interface CreateBackfillInput {
  pipelineId: string;
  from: string;
  to: string;
  intervalSeconds?: number;
  cron?: string;
  timezone?: string;
  concurrency?: number;
  confirmLargeBackfill?: boolean;
  versionId?: string;
}

export async function createBackfill(context: ApiContext, input: CreateBackfillInput): Promise<Backfill> {
  authorize(context, "backfill.create");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, input.pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", input.pipelineId);

  const versionId = input.versionId ?? pipeline.publishedVersionId;
  if (!versionId) throw ApiError.validation("Publish the pipeline before backfilling it");

  const backfill = planBackfill({
    organizationId,
    pipelineId: input.pipelineId,
    pipelineVersionId: versionId,
    from: new Date(input.from),
    to: new Date(input.to),
    ...(input.intervalSeconds ? { intervalSeconds: input.intervalSeconds } : {}),
    ...(input.cron ? { cron: input.cron } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(input.confirmLargeBackfill ? { confirmLargeBackfill: true } : {}),
    createdBy: context.principal.userId,
    now: context.now,
  });

  return audited(
    context,
    {
      action: "backfill.create",
      resourceType: "backfill",
      resourceId: backfill.id,
      metadata: { pipelineId: input.pipelineId, totalRuns: backfill.totalRuns, from: input.from, to: input.to },
    },
    async () => context.store.createBackfill(backfill),
  );
}

export async function getBackfill(context: ApiContext, backfillId: string): Promise<BackfillProgress & { backfill: Backfill }> {
  authorize(context, "pipeline.read");
  const backfill = await context.store.getBackfill(context.principal.organizationId, backfillId);
  if (!backfill) throw ApiError.notFound("Backfill", backfillId);
  const progress = await backfillProgress(context.store, context.principal.organizationId, backfillId);
  return { ...progress, backfill };
}

export async function setBackfillState(
  context: ApiContext,
  backfillId: string,
  state: "running" | "paused" | "cancelled",
): Promise<Backfill> {
  authorize(context, "backfill.create");
  const organizationId = context.principal.organizationId;
  const backfill = await context.store.getBackfill(organizationId, backfillId);
  if (!backfill) throw ApiError.notFound("Backfill", backfillId);
  if (["completed", "failed", "cancelled"].includes(backfill.state)) {
    throw ApiError.conflict(`Backfill is already ${backfill.state}`);
  }

  return audited(context, { action: `backfill.${state}`, resourceType: "backfill", resourceId: backfillId }, async () =>
    context.store.updateBackfill(organizationId, backfillId, {
      state,
      updatedAt: context.now.toISOString(),
      ...(state === "cancelled" ? { finishedAt: context.now.toISOString(), pendingDates: [] } : {}),
    }),
  );
}

/** Dispatches the next slice of a backfill. Called by the worker's timer. */
export async function tickBackfill(context: ApiContext, backfillId: string): Promise<BackfillProgress> {
  const organizationId = context.principal.organizationId;
  return advanceBackfill(context.store, organizationId, backfillId, {
    now: context.now,
    startRun: async ({ backfill, logicalDate }) => {
      const version = await context.store.getVersion(organizationId, backfill.pipelineVersionId);
      const pipeline = await context.store.getPipeline(organizationId, backfill.pipelineId);
      if (!version || !pipeline) return null;
      return context.engine.startRun({
        organizationId,
        pipelineId: backfill.pipelineId,
        pipelineName: pipeline.name,
        pipelineVersionId: version.id,
        version: version.version,
        definition: version.definition,
        trigger: "backfill",
        triggeredBy: backfill.createdBy,
        logicalDate,
        backfillId: backfill.id,
        ...(pipeline.isDemo ? { isDemo: true } : {}),
      });
    },
  });
}
