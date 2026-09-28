import { describe, expect, it } from "vitest";
import { MemoryStore, type Schedule, type Store } from "@dataflow-studio/database";
import { newId } from "@dataflow-studio/observability";
import {
  CronParseError, describeCron, isValidCron, isValidTimezone, matchesCron,
  nextCronOccurrence, nextCronOccurrences, parseCron, zonedParts,
} from "./cron.js";
import {
  advanceSchedule, buildSchedule, dispatchDueSchedules, expandDueSchedule, ScheduleConfigError,
} from "./schedule.js";
import {
  advanceBackfill, backfillProgress, BackfillConfigError, BACKFILL_MAX_CONCURRENCY, planBackfill,
} from "./backfill.js";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("parses a five-field expression", () => {
    const fields = parseCron("30 2 * * *");
    expect([...fields.minutes]).toEqual([30]);
    expect([...fields.hours]).toEqual([2]);
    expect(fields.dayOfMonthRestricted).toBe(false);
    expect(fields.dayOfWeekRestricted).toBe(false);
  });

  it("supports lists, ranges and steps", () => {
    expect([...parseCron("0,15,30,45 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-17 * * *").hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 0 * * 1-5").daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("supports month and weekday names", () => {
    expect([...parseCron("0 0 1 jan,jul *").months]).toEqual([1, 7]);
    expect([...parseCron("0 0 * * mon").daysOfWeek]).toEqual([1]);
  });

  it("treats 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("expands macros", () => {
    expect(parseCron("@daily")).toMatchObject({ minutes: new Set([0]), hours: new Set([0]) });
    expect([...parseCron("@weekly").daysOfWeek]).toEqual([0]);
    expect([...parseCron("@hourly").minutes]).toEqual([0]);
  });

  it("rejects malformed expressions with a useful message", () => {
    expect(() => parseCron("* * *")).toThrow(/Expected 5 cron fields/);
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* 25 * * *")).toThrow(/out of bounds/);
    expect(() => parseCron("* * * * 9")).toThrow(/out of bounds/);
    expect(() => parseCron("abc * * * *")).toThrow(/Invalid value/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/Step must be at least 1/);
    expect(() => parseCron("0 0 1 13 *")).toThrow(/out of bounds/);
    expect(isValidCron("nonsense")).toBe(false);
    expect(isValidCron("0 2 * * *")).toBe(true);
  });
});

describe("nextCronOccurrence", () => {
  it("finds the next daily firing in UTC", () => {
    expect(nextCronOccurrence("0 2 * * *", at("2026-03-30T12:00:00Z"), "UTC")?.toISOString())
      .toBe("2026-03-31T02:00:00.000Z");
  });

  it("is strictly after the given instant", () => {
    expect(nextCronOccurrence("0 2 * * *", at("2026-03-31T02:00:00Z"), "UTC")?.toISOString())
      .toBe("2026-04-01T02:00:00.000Z");
  });

  it("respects a non-UTC timezone", () => {
    // 02:00 in Berlin during CEST is 00:00 UTC.
    expect(nextCronOccurrence("0 2 * * *", at("2026-07-01T12:00:00Z"), "Europe/Berlin")?.toISOString())
      .toBe("2026-07-02T00:00:00.000Z");
    // During CET it is 01:00 UTC.
    expect(nextCronOccurrence("0 2 * * *", at("2026-01-01T12:00:00Z"), "Europe/Berlin")?.toISOString())
      .toBe("2026-01-02T01:00:00.000Z");
  });

  it("handles a half-hour offset zone", () => {
    expect(nextCronOccurrence("0 9 * * *", at("2026-06-01T00:00:00Z"), "Asia/Kolkata")?.toISOString())
      .toBe("2026-06-01T03:30:00.000Z");
  });

  it("skips a wall-clock time that does not exist on a spring-forward day", () => {
    // Europe/Berlin jumps 02:00 -> 03:00 on 2026-03-29, so 02:30 never happens.
    const next = nextCronOccurrence("30 2 * * *", at("2026-03-28T12:00:00Z"), "Europe/Berlin");
    expect(next?.toISOString()).toBe("2026-03-30T00:30:00.000Z");
  });

  it("finds a leap-day schedule within four years", () => {
    expect(nextCronOccurrence("0 0 29 2 *", at("2026-03-01T00:00:00Z"), "UTC")?.toISOString())
      .toBe("2028-02-29T00:00:00.000Z");
  });

  it("applies OR semantics when both day fields are restricted", () => {
    // Day 1 of the month OR any Monday.
    const fields = parseCron("0 0 1 * 1");
    expect(matchesCron(fields, at("2026-04-01T00:00:00Z"), "UTC")).toBe(true); // a Wednesday, day 1
    expect(matchesCron(fields, at("2026-04-06T00:00:00Z"), "UTC")).toBe(true); // a Monday
    expect(matchesCron(fields, at("2026-04-07T00:00:00Z"), "UTC")).toBe(false);
  });

  it("lists several upcoming firings", () => {
    const next = nextCronOccurrences("0 */6 * * *", at("2026-03-31T01:00:00Z"), "UTC", 3);
    expect(next.map((d) => d.toISOString())).toEqual([
      "2026-03-31T06:00:00.000Z",
      "2026-03-31T12:00:00.000Z",
      "2026-03-31T18:00:00.000Z",
    ]);
  });

  it("rejects an unknown timezone", () => {
    expect(() => nextCronOccurrence("0 0 * * *", new Date(), "Mars/Olympus")).toThrow(/Unknown timezone/);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Nowhere/Nothing")).toBe(false);
  });

  it("reads wall-clock parts in the target zone", () => {
    expect(zonedParts(at("2026-07-01T00:30:00Z"), "Europe/Berlin")).toMatchObject({ hour: 2, minute: 30, day: 1, month: 7 });
    expect(zonedParts(at("2026-07-01T00:00:00Z"), "UTC").hour).toBe(0);
  });
});

describe("describeCron", () => {
  it.each([
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 2 * * *", "Every day at 02:00 UTC"],
    ["0 2 * * 1", "Every Monday at 02:00 UTC"],
    ["30 * * * *", "Hourly at 30 past"],
    ["@daily", "Every day at 00:00 UTC"],
  ])("%s -> %s", (expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  it("names the timezone when it is not UTC", () => {
    expect(describeCron("0 2 * * *", "Europe/Berlin")).toBe("Every day at 02:00 Europe/Berlin");
  });
});

describe("buildSchedule", () => {
  const base = { organizationId: "o", pipelineId: "p", createdBy: "u", now: at("2026-03-31T12:00:00Z") };

  it("builds a cron schedule with its first firing", () => {
    const schedule = buildSchedule({ ...base, kind: "cron", cron: "0 2 * * *", timezone: "UTC" });
    expect(schedule.nextRunAt).toBe("2026-04-01T02:00:00.000Z");
    expect(schedule.enabled).toBe(true);
    expect(schedule.catchup).toBe(false);
  });

  it("builds an interval schedule", () => {
    const schedule = buildSchedule({ ...base, kind: "interval", intervalSeconds: 900 });
    expect(schedule.nextRunAt).toBe("2026-03-31T12:15:00.000Z");
  });

  it("rejects invalid input", () => {
    expect(() => buildSchedule({ ...base, kind: "cron", cron: "nope" })).toThrow(ScheduleConfigError);
    expect(() => buildSchedule({ ...base, kind: "cron", cron: "0 2 * * *", timezone: "Mars/Olympus" })).toThrow(/Unknown timezone/);
    expect(() => buildSchedule({ ...base, kind: "interval", intervalSeconds: 5 })).toThrow(/between 60 and/);
    expect(() => buildSchedule({ ...base, kind: "interval", intervalSeconds: 10.5 })).toThrow(ScheduleConfigError);
  });
});

describe("advanceSchedule / expandDueSchedule", () => {
  const schedule: Schedule = {
    id: "sch_1", organizationId: "o", pipelineId: "p", kind: "cron", cron: "0 * * * *",
    timezone: "UTC", enabled: true, catchup: false,
    nextRunAt: "2026-03-31T00:00:00.000Z", createdBy: "u",
    createdAt: "2026-03-31T00:00:00.000Z", updatedAt: "2026-03-31T00:00:00.000Z",
  };

  it("skips missed intervals when catchup is off", () => {
    const { nextRunAt, skipped } = advanceSchedule(schedule, at("2026-03-31T05:30:00Z"));
    expect(nextRunAt).toBe("2026-03-31T06:00:00.000Z");
    expect(skipped).toBeGreaterThan(0);
  });

  it("fires once for a long outage when catchup is off", () => {
    const expanded = expandDueSchedule(schedule, at("2026-03-31T05:30:00Z"));
    expect(expanded.logicalDates).toEqual(["2026-03-31T00:00:00.000Z"]);
    expect(expanded.schedule.nextRunAt).toBe("2026-03-31T06:00:00.000Z");
  });

  it("replays each missed interval when catchup is on", () => {
    const expanded = expandDueSchedule({ ...schedule, catchup: true }, at("2026-03-31T03:30:00Z"));
    expect(expanded.logicalDates).toEqual([
      "2026-03-31T00:00:00.000Z",
      "2026-03-31T01:00:00.000Z",
      "2026-03-31T02:00:00.000Z",
      "2026-03-31T03:00:00.000Z",
    ]);
  });

  it("caps catchup so an outage cannot flood the queue", () => {
    const expanded = expandDueSchedule({ ...schedule, catchup: true }, at("2026-04-30T00:00:00Z"), 10);
    expect(expanded.logicalDates).toHaveLength(10);
  });
});

async function seedStore(): Promise<{ store: Store; organizationId: string; pipelineId: string; versionId: string }> {
  const store = new MemoryStore();
  const organizationId = "org_1";
  const now = new Date().toISOString();
  await store.createOrganization({ id: organizationId, name: "Acme", slug: "acme", createdAt: now });
  const pipelineId = newId("pipe");
  const versionId = newId("ver");
  await store.createPipeline({
    id: pipelineId, organizationId, name: "daily-sales", publishedVersionId: versionId,
    latestVersionNumber: 1, createdBy: "u", createdAt: now, updatedAt: now,
  });
  await store.createVersion({
    id: versionId, organizationId, pipelineId, version: 1, status: "published",
    definition: { name: "daily-sales", version: 1, nodes: [], edges: [] }, definitionHash: "h",
    createdBy: "u", createdAt: now,
  });
  return { store, organizationId, pipelineId, versionId };
}

describe("dispatchDueSchedules", () => {
  it("starts a run for a due schedule and advances it", async () => {
    const { store, organizationId, pipelineId, versionId } = await seedStore();
    const now = at("2026-03-31T02:00:30Z");
    const schedule = buildSchedule({
      organizationId, pipelineId, kind: "cron", cron: "0 2 * * *", timezone: "UTC",
      createdBy: "u", now: at("2026-03-30T12:00:00Z"),
    });
    await store.createSchedule(schedule);

    const started: string[] = [];
    const results = await dispatchDueSchedules(store, {
      now,
      startRun: async ({ schedule: s, logicalDate }) => {
        started.push(logicalDate);
        const run = {
          id: newId("run"), organizationId, pipelineId: s.pipelineId, pipelineVersionId: versionId,
          pipelineName: "daily-sales", version: 1, state: "QUEUED" as const, trigger: "schedule" as const,
          triggeredBy: "system", queuedAt: now.toISOString(), logicalDate, scheduleId: s.id,
        };
        await store.createRun(run, []);
        return run;
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.runIds).toHaveLength(1);
    expect(started).toEqual(["2026-03-31T02:00:00.000Z"]);
    const updated = await store.getSchedule(organizationId, schedule.id);
    expect(updated?.nextRunAt).toBe("2026-04-01T02:00:00.000Z");
    expect(updated?.lastRunId).toBe(results[0]!.runIds[0]);
  });

  it("does not fire a schedule twice for the same logical date", async () => {
    const { store, organizationId, pipelineId, versionId } = await seedStore();
    const now = at("2026-03-31T02:05:00Z");
    const schedule = buildSchedule({
      organizationId, pipelineId, kind: "cron", cron: "0 2 * * *", createdBy: "u", now: at("2026-03-30T12:00:00Z"),
    });
    await store.createSchedule(schedule);
    await store.createRun({
      id: newId("run"), organizationId, pipelineId, pipelineVersionId: versionId, pipelineName: "daily-sales",
      version: 1, state: "SUCCESS", trigger: "schedule", triggeredBy: "system",
      queuedAt: now.toISOString(), logicalDate: "2026-03-31T02:00:00.000Z", scheduleId: schedule.id,
    }, []);

    const results = await dispatchDueSchedules(store, { now, startRun: async () => { throw new Error("must not start"); } });
    expect(results[0]).toMatchObject({ runIds: [], skippedDuplicates: 1 });
  });

  it("ignores disabled schedules", async () => {
    const { store, organizationId, pipelineId } = await seedStore();
    const schedule = buildSchedule({
      organizationId, pipelineId, kind: "interval", intervalSeconds: 60, enabled: false,
      createdBy: "u", now: at("2026-03-31T00:00:00Z"),
    });
    await store.createSchedule(schedule);
    const results = await dispatchDueSchedules(store, {
      now: at("2026-03-31T12:00:00Z"),
      startRun: async () => { throw new Error("must not start"); },
    });
    expect(results).toHaveLength(0);
  });

  it("records an error without losing the schedule", async () => {
    const { store, organizationId, pipelineId } = await seedStore();
    const schedule = buildSchedule({
      organizationId, pipelineId, kind: "interval", intervalSeconds: 60, createdBy: "u", now: at("2026-03-31T00:00:00Z"),
    });
    await store.createSchedule(schedule);
    const results = await dispatchDueSchedules(store, {
      now: at("2026-03-31T12:00:00Z"),
      startRun: async () => { throw new Error("pipeline has no published version"); },
    });
    expect(results[0]!.error).toMatch(/no published version/);
    expect(await store.getSchedule(organizationId, schedule.id)).toBeTruthy();
  });
});

describe("planBackfill", () => {
  const base = {
    organizationId: "o", pipelineId: "p", pipelineVersionId: "v", createdBy: "u",
    now: at("2026-06-01T00:00:00Z"),
  };

  it("plans one run per day for the documented range", () => {
    const backfill = planBackfill({
      ...base, from: at("2026-01-01T00:00:00Z"), to: at("2026-03-31T00:00:00Z"),
      intervalSeconds: 86_400, confirmLargeBackfill: true,
    });
    expect(backfill.totalRuns).toBe(90);
    expect(backfill.pendingDates[0]).toBe("2026-01-01T00:00:00.000Z");
    expect(backfill.pendingDates.at(-1)).toBe("2026-03-31T00:00:00.000Z");
    expect(backfill.state).toBe("pending");
  });

  it("plans from a cron expression", () => {
    const backfill = planBackfill({
      ...base, from: at("2026-05-01T00:00:00Z"), to: at("2026-05-07T23:59:00Z"), cron: "0 2 * * *",
    });
    expect(backfill.totalRuns).toBe(7);
    expect(backfill.pendingDates[0]).toBe("2026-05-01T02:00:00.000Z");
  });

  it("requires confirmation above the warning threshold", () => {
    expect(() => planBackfill({
      ...base, from: at("2026-01-01T00:00:00Z"), to: at("2026-05-01T00:00:00Z"), intervalSeconds: 86_400,
    })).toThrow(/Re-submit with confirmation/);
  });

  it("refuses an absurd range outright", () => {
    expect(() => planBackfill({
      ...base, from: at("2020-01-01T00:00:00Z"), to: at("2026-01-01T00:00:00Z"),
      intervalSeconds: 60, confirmLargeBackfill: true,
    })).toThrow(/over the 10,000 limit/);
  });

  it("validates the range and concurrency", () => {
    expect(() => planBackfill({ ...base, from: at("2026-03-01T00:00:00Z"), to: at("2026-01-01T00:00:00Z") }))
      .toThrow(/must not be earlier/);
    expect(() => planBackfill({ ...base, from: at("2026-12-01T00:00:00Z"), to: at("2026-12-02T00:00:00Z") }))
      .toThrow(/in the future/);
    expect(() => planBackfill({ ...base, from: at("2026-01-01T00:00:00Z"), to: at("2026-01-02T00:00:00Z"), concurrency: 0 }))
      .toThrow(/Concurrency must be between 1 and 20/);
    expect(() => planBackfill({ ...base, from: at("2026-01-01T00:00:00Z"), to: at("2026-01-02T00:00:00Z"), concurrency: BACKFILL_MAX_CONCURRENCY + 1 }))
      .toThrow(BackfillConfigError);
    expect(() => planBackfill({ ...base, from: at("2026-01-01T00:00:00Z"), to: at("2026-01-02T00:00:00Z"), intervalSeconds: 10 }))
      .toThrow(/at least 60 seconds/);
  });
});

describe("advanceBackfill", () => {
  it("dispatches up to the concurrency limit and tracks progress", async () => {
    const { store, organizationId, pipelineId, versionId } = await seedStore();
    const backfill = planBackfill({
      organizationId, pipelineId, pipelineVersionId: versionId, createdBy: "u",
      from: at("2026-01-01T00:00:00Z"), to: at("2026-01-05T00:00:00Z"), intervalSeconds: 86_400,
      concurrency: 2, now: at("2026-06-01T00:00:00Z"),
    });
    await store.createBackfill(backfill);

    const startRun = async ({ logicalDate }: { logicalDate: string }) => {
      const run = {
        id: newId("run"), organizationId, pipelineId, pipelineVersionId: versionId, pipelineName: "daily-sales",
        version: 1, state: "QUEUED" as const, trigger: "backfill" as const, triggeredBy: "u",
        queuedAt: new Date().toISOString(), logicalDate, backfillId: backfill.id,
      };
      await store.createRun(run, []);
      return run;
    };

    let progress = await advanceBackfill(store, organizationId, backfill.id, { startRun });
    expect(progress.total).toBe(5);
    expect(progress.remaining).toBe(3);
    expect(progress.running).toBe(2);
    expect(progress.state).toBe("running");

    // While two runs are in flight, nothing else is dispatched.
    progress = await advanceBackfill(store, organizationId, backfill.id, { startRun });
    expect(progress.remaining).toBe(3);

    // Finish them, then the next slice goes out.
    for (const run of (await store.listRuns(organizationId, { backfillId: backfill.id })).items) {
      await store.updateRun(organizationId, run.id, { state: "SUCCESS", finishedAt: new Date().toISOString(), durationMs: 10 });
    }
    progress = await advanceBackfill(store, organizationId, backfill.id, { startRun });
    expect(progress.completed).toBe(2);
    expect(progress.remaining).toBe(1);
    expect(progress.percentComplete).toBe(40);
  });

  it("marks a backfill completed once every run finished", async () => {
    const { store, organizationId, pipelineId, versionId } = await seedStore();
    const backfill = planBackfill({
      organizationId, pipelineId, pipelineVersionId: versionId, createdBy: "u",
      from: at("2026-01-01T00:00:00Z"), to: at("2026-01-02T00:00:00Z"), intervalSeconds: 86_400,
      concurrency: 2, now: at("2026-06-01T00:00:00Z"),
    });
    await store.createBackfill(backfill);
    const startRun = async ({ logicalDate }: { logicalDate: string }) => {
      const run = {
        id: newId("run"), organizationId, pipelineId, pipelineVersionId: versionId, pipelineName: "d",
        version: 1, state: "SUCCESS" as const, trigger: "backfill" as const, triggeredBy: "u",
        queuedAt: new Date().toISOString(), logicalDate, backfillId: backfill.id, durationMs: 5,
      };
      await store.createRun(run, []);
      return run;
    };
    await advanceBackfill(store, organizationId, backfill.id, { startRun });
    const progress = await advanceBackfill(store, organizationId, backfill.id, { startRun });
    expect(progress.state).toBe("completed");
    expect(progress.percentComplete).toBe(100);
  });

  it("does not dispatch a paused or cancelled backfill", async () => {
    const { store, organizationId, pipelineId, versionId } = await seedStore();
    const backfill = planBackfill({
      organizationId, pipelineId, pipelineVersionId: versionId, createdBy: "u",
      from: at("2026-01-01T00:00:00Z"), to: at("2026-01-03T00:00:00Z"), intervalSeconds: 86_400,
      now: at("2026-06-01T00:00:00Z"),
    });
    await store.createBackfill({ ...backfill, state: "paused" });
    const progress = await advanceBackfill(store, organizationId, backfill.id, {
      startRun: async () => { throw new Error("must not start"); },
    });
    expect(progress.state).toBe("paused");
    expect(progress.remaining).toBe(3);
  });

  it("reports an unknown backfill clearly", async () => {
    const { store } = await seedStore();
    await expect(backfillProgress(store, "org_1", "bfl_missing")).rejects.toThrow(/was not found/);
  });
});
