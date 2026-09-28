import type { Backfill, Store } from "@dataflow-studio/database";
import { newId } from "@dataflow-studio/observability";
import { nextCronOccurrence } from "./cron.js";

export class BackfillConfigError extends Error {
  readonly errorClass = "validation";
  constructor(message: string) {
    super(message);
    this.name = "BackfillConfigError";
  }
}

export interface PlanBackfillInput {
  organizationId: string;
  pipelineId: string;
  pipelineVersionId: string;
  from: Date;
  to: Date;
  /** Interval between logical dates. Ignored when `cron` is supplied. */
  intervalSeconds?: number;
  cron?: string;
  timezone?: string;
  concurrency?: number;
  createdBy: string;
  now?: Date;
  /** Required to exceed `warnThreshold` runs: prevents an accidental 10k-run backfill. */
  confirmLargeBackfill?: boolean;
}

export const BACKFILL_WARN_THRESHOLD = 100;
export const BACKFILL_MAX_RUNS = 10_000;
export const BACKFILL_MAX_CONCURRENCY = 20;

/** Computes the logical dates a backfill covers, with guard rails. */
export function planBackfill(input: PlanBackfillInput): Backfill {
  const now = input.now ?? new Date();
  if (!(input.from instanceof Date) || Number.isNaN(input.from.getTime())) {
    throw new BackfillConfigError("`from` is not a valid date");
  }
  if (!(input.to instanceof Date) || Number.isNaN(input.to.getTime())) {
    throw new BackfillConfigError("`to` is not a valid date");
  }
  if (input.to < input.from) {
    throw new BackfillConfigError("Backfill `to` must not be earlier than `from`");
  }
  if (input.from > now) {
    throw new BackfillConfigError("Backfill `from` is in the future; backfills replay the past");
  }

  const concurrency = input.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > BACKFILL_MAX_CONCURRENCY) {
    throw new BackfillConfigError(`Concurrency must be between 1 and ${BACKFILL_MAX_CONCURRENCY}`);
  }

  const dates: string[] = [];
  if (input.cron) {
    let cursor = new Date(input.from.getTime() - 1);
    while (dates.length <= BACKFILL_MAX_RUNS) {
      const next = nextCronOccurrence(input.cron, cursor, input.timezone ?? "UTC");
      if (!next || next > input.to) break;
      dates.push(next.toISOString());
      cursor = next;
    }
  } else {
    const intervalSeconds = input.intervalSeconds ?? 86_400;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
      throw new BackfillConfigError("Backfill interval must be an integer of at least 60 seconds");
    }
    const span = (input.to.getTime() - input.from.getTime()) / 1000;
    const count = Math.floor(span / intervalSeconds) + 1;
    if (count > BACKFILL_MAX_RUNS) {
      throw new BackfillConfigError(
        `That range would create ${count.toLocaleString("en-US")} runs, over the ${BACKFILL_MAX_RUNS.toLocaleString("en-US")} limit. Narrow the range or widen the interval.`,
      );
    }
    for (let i = 0; i < count; i++) {
      dates.push(new Date(input.from.getTime() + i * intervalSeconds * 1000).toISOString());
    }
  }

  if (!dates.length) {
    throw new BackfillConfigError("That range and interval produce no runs");
  }
  if (dates.length > BACKFILL_MAX_RUNS) {
    throw new BackfillConfigError(`Backfill would create more than ${BACKFILL_MAX_RUNS} runs`);
  }
  if (dates.length > BACKFILL_WARN_THRESHOLD && !input.confirmLargeBackfill) {
    throw new BackfillConfigError(
      `This backfill would create ${dates.length} runs. Re-submit with confirmation to proceed.`,
    );
  }

  return {
    id: newId("bfl"),
    organizationId: input.organizationId,
    pipelineId: input.pipelineId,
    pipelineVersionId: input.pipelineVersionId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    intervalSeconds: input.intervalSeconds ?? 86_400,
    concurrency,
    state: "pending",
    totalRuns: dates.length,
    completedRuns: 0,
    failedRuns: 0,
    pendingDates: dates,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export interface BackfillProgress {
  backfillId: string;
  total: number;
  completed: number;
  failed: number;
  remaining: number;
  running: number;
  percentComplete: number;
  state: Backfill["state"];
  currentDates: string[];
}

export async function backfillProgress(store: Store, organizationId: string, backfillId: string): Promise<BackfillProgress> {
  const backfill = await store.getBackfill(organizationId, backfillId);
  if (!backfill) throw new BackfillConfigError(`Backfill "${backfillId}" was not found`);
  const runs = await store.listRuns(organizationId, { backfillId, limit: 200 });
  const running = runs.items.filter((r) => r.state === "RUNNING" || r.state === "QUEUED");

  return {
    backfillId,
    total: backfill.totalRuns,
    completed: backfill.completedRuns,
    failed: backfill.failedRuns,
    remaining: backfill.pendingDates.length,
    running: running.length,
    percentComplete: backfill.totalRuns
      ? Math.round(((backfill.completedRuns + backfill.failedRuns) / backfill.totalRuns) * 100)
      : 0,
    state: backfill.state,
    currentDates: running.map((r) => r.logicalDate ?? r.queuedAt),
  };
}

export interface AdvanceBackfillOptions {
  now?: Date;
  startRun: (input: { backfill: Backfill; logicalDate: string }) => Promise<{ id: string } | null>;
}

/**
 * Dispatches the next slice of a backfill, respecting its concurrency limit and
 * folding finished runs into its counters. Called on a timer by the worker.
 */
export async function advanceBackfill(
  store: Store,
  organizationId: string,
  backfillId: string,
  options: AdvanceBackfillOptions,
): Promise<BackfillProgress> {
  const now = options.now ?? new Date();
  const backfill = await store.getBackfill(organizationId, backfillId);
  if (!backfill) throw new BackfillConfigError(`Backfill "${backfillId}" was not found`);
  if (["completed", "cancelled", "paused", "failed"].includes(backfill.state)) {
    return backfillProgress(store, organizationId, backfillId);
  }

  const runs = await store.listRuns(organizationId, { backfillId, limit: 500 });
  const inFlight = runs.items.filter((r) => r.state === "RUNNING" || r.state === "QUEUED").length;
  const completed = runs.items.filter((r) => r.state === "SUCCESS").length;
  const failed = runs.items.filter((r) => r.state === "FAILED" || r.state === "CANCELLED").length;

  const slots = Math.max(0, backfill.concurrency - inFlight);
  const dispatching = backfill.pendingDates.slice(0, slots);
  const started: string[] = [];

  for (const logicalDate of dispatching) {
    const run = await options.startRun({ backfill, logicalDate });
    if (run) started.push(logicalDate);
  }

  const pendingDates = backfill.pendingDates.filter((date) => !started.includes(date));
  const finishedCount = completed + failed;
  const state: Backfill["state"] =
    pendingDates.length === 0 && inFlight === 0 && started.length === 0
      ? finishedCount >= backfill.totalRuns
        ? failed > 0 ? "failed" : "completed"
        : "running"
      : "running";

  await store.updateBackfill(organizationId, backfillId, {
    state,
    pendingDates,
    completedRuns: completed,
    failedRuns: failed,
    updatedAt: now.toISOString(),
    ...(state === "completed" || state === "failed" ? { finishedAt: now.toISOString() } : {}),
  });

  return backfillProgress(store, organizationId, backfillId);
}
