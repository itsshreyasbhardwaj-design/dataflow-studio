import type { Schedule, Store } from "@dataflow-studio/database";
import { newId } from "@dataflow-studio/observability";
import { isValidCron, isValidTimezone, nextCronOccurrence } from "./cron.js";

export class ScheduleConfigError extends Error {
  readonly errorClass = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConfigError";
  }
}

export interface ScheduleInput {
  organizationId: string;
  pipelineId: string;
  pipelineVersionId?: string | null;
  kind: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
  timezone?: string;
  enabled?: boolean;
  catchup?: boolean;
  createdBy: string;
  startAt?: Date;
  now?: Date;
}

const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 365 * 24 * 3600;

/** Validates and normalizes a schedule, computing its first firing. */
export function buildSchedule(input: ScheduleInput): Schedule {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? "UTC";
  if (!isValidTimezone(timezone)) {
    throw new ScheduleConfigError(`Unknown timezone "${timezone}". Use an IANA name such as "Europe/Berlin".`);
  }

  if (input.kind === "cron") {
    if (!input.cron || !isValidCron(input.cron)) {
      throw new ScheduleConfigError(`"${input.cron ?? ""}" is not a valid cron expression`);
    }
  } else {
    const seconds = input.intervalSeconds ?? 0;
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
      throw new ScheduleConfigError(
        `Interval must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds`,
      );
    }
  }

  const from = input.startAt ?? now;
  const nextRunAt = input.kind === "cron"
    ? nextCronOccurrence(input.cron!, from, timezone)
    : new Date(from.getTime() + input.intervalSeconds! * 1000);
  if (!nextRunAt) {
    throw new ScheduleConfigError(`Cron expression "${input.cron}" will never fire`);
  }

  return {
    id: newId("sch"),
    organizationId: input.organizationId,
    pipelineId: input.pipelineId,
    ...(input.pipelineVersionId ? { pipelineVersionId: input.pipelineVersionId } : {}),
    kind: input.kind,
    ...(input.kind === "cron" ? { cron: input.cron! } : { intervalSeconds: input.intervalSeconds! }),
    timezone,
    enabled: input.enabled ?? true,
    catchup: input.catchup ?? false,
    nextRunAt: nextRunAt.toISOString(),
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Advances `nextRunAt` past `now`, so a paused scheduler does not replay history. */
export function advanceSchedule(schedule: Schedule, now: Date): { nextRunAt: string; skipped: number } {
  let skipped = 0;
  let cursor = new Date(schedule.nextRunAt);

  for (let guard = 0; guard < 10_000; guard++) {
    const next = schedule.kind === "cron"
      ? nextCronOccurrence(schedule.cron!, cursor, schedule.timezone)
      : new Date(cursor.getTime() + (schedule.intervalSeconds ?? 3600) * 1000);
    if (!next) break;
    cursor = next;
    if (cursor > now) break;
    // With catchup enabled the caller dispatches each missed interval itself;
    // without it we simply move on and count what was skipped.
    skipped++;
    if (schedule.catchup) break;
  }
  return { nextRunAt: cursor.toISOString(), skipped };
}

export interface DueSchedule {
  schedule: Schedule;
  /** The logical dates to dispatch: one, or several when catching up. */
  logicalDates: string[];
  skipped: number;
}

/**
 * Expands a due schedule into the runs that should be created.
 *
 * Without catchup a schedule that was down for a day fires once, now. With
 * catchup it fires once per missed interval, capped so a week-long outage cannot
 * enqueue ten thousand runs by surprise.
 */
export function expandDueSchedule(schedule: Schedule, now: Date, maxCatchup = 50): DueSchedule {
  if (!schedule.catchup) {
    const { nextRunAt, skipped } = advanceSchedule(schedule, now);
    return { schedule: { ...schedule, nextRunAt }, logicalDates: [schedule.nextRunAt], skipped };
  }

  const logicalDates: string[] = [];
  let cursor = new Date(schedule.nextRunAt);
  while (cursor <= now && logicalDates.length < maxCatchup) {
    logicalDates.push(cursor.toISOString());
    const next = schedule.kind === "cron"
      ? nextCronOccurrence(schedule.cron!, cursor, schedule.timezone)
      : new Date(cursor.getTime() + (schedule.intervalSeconds ?? 3600) * 1000);
    if (!next) break;
    cursor = next;
  }
  return { schedule: { ...schedule, nextRunAt: cursor.toISOString() }, logicalDates, skipped: 0 };
}

export interface DispatchResult {
  scheduleId: string;
  pipelineId: string;
  runIds: string[];
  skippedDuplicates: number;
  skippedIntervals: number;
  error?: string;
}

export interface DispatchOptions {
  now?: Date;
  limit?: number;
  maxCatchup?: number;
  /** Creates one run. Returns null when the run already exists for that logical date. */
  startRun: (input: {
    schedule: Schedule;
    logicalDate: string;
  }) => Promise<{ id: string } | null>;
}

/**
 * One tick of the scheduler.
 *
 * Duplicate protection is deliberately layered: this function checks for an
 * existing run at the same logical date, and the database has a unique index on
 * (schedule_id, logical_date) as the real guarantee. A scheduler that fires twice
 * during a failover must not double-charge anybody.
 */
export async function dispatchDueSchedules(store: Store, options: DispatchOptions): Promise<DispatchResult[]> {
  const now = options.now ?? new Date();
  const due = await store.claimDueSchedules(now, options.limit ?? 50);
  const results: DispatchResult[] = [];

  for (const schedule of due) {
    const expanded = expandDueSchedule(schedule, now, options.maxCatchup ?? 50);
    const runIds: string[] = [];
    let skippedDuplicates = 0;
    let error: string | undefined;

    for (const logicalDate of expanded.logicalDates) {
      try {
        const existing = await store.listRuns(schedule.organizationId, { scheduleId: schedule.id, limit: 200 });
        if (existing.items.some((run) => run.logicalDate === logicalDate)) {
          skippedDuplicates++;
          continue;
        }
        const run = await options.startRun({ schedule, logicalDate });
        if (run) runIds.push(run.id);
        else skippedDuplicates++;
      } catch (cause) {
        error = (cause as Error).message;
        break;
      }
    }

    await store.updateSchedule(schedule.organizationId, schedule.id, {
      nextRunAt: expanded.schedule.nextRunAt,
      lastRunAt: runIds.length ? now.toISOString() : schedule.lastRunAt ?? null,
      ...(runIds.length ? { lastRunId: runIds.at(-1)! } : {}),
      updatedAt: now.toISOString(),
    });

    results.push({
      scheduleId: schedule.id,
      pipelineId: schedule.pipelineId,
      runIds,
      skippedDuplicates,
      skippedIntervals: expanded.skipped,
      ...(error ? { error } : {}),
    });
  }
  return results;
}
