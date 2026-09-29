# Scheduling and backfills

## Schedules

A schedule fires a pipeline's **published** version, unless a version is pinned.

```json
{ "pipelineId": "pipe_123", "kind": "cron", "cron": "0 2 * * *", "timezone": "Europe/Berlin", "catchup": false }
{ "pipelineId": "pipe_123", "kind": "interval", "intervalSeconds": 900 }
```

Timezone is stored explicitly. `"0 2 * * *"` in `Europe/Berlin` means 02:00 local
time all year, which is 00:00 UTC in summer and 01:00 UTC in winter.

## Cron

Five fields — minute, hour, day-of-month, month, day-of-week — plus the usual
macros (`@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `@midnight`).
Lists (`0,15,30`), ranges (`9-17`), steps (`*/15`), month and weekday names
(`jan`, `mon`), and `7` as Sunday are all supported.

When both day fields are restricted they are OR-ed, as Vixie cron does:
`0 0 1 * 1` fires on the first of the month **and** every Monday.

The parser is written here rather than taken from a library, for two reasons:
schedule semantics are what users complain about most, so they deserve tests we
own; and the worker's dependency surface stays small. Timezone arithmetic goes
through `Intl`, so it tracks the platform's zone database rather than a bundled
copy.

### Daylight saving

The next firing is found by walking forward in UTC and testing the local wall
clock, which gives correct behaviour without special cases:

- **Spring forward.** `30 2 * * *` in `Europe/Berlin` on the day the clock jumps
  02:00 → 03:00: 02:30 never exists, so the schedule does not fire that day.
- **Fall back.** The repeated hour would match twice; the unique index on
  `(schedule_id, logical_date)` means the second attempt is a duplicate and is
  skipped.

`nextCronOccurrences(expression, after, timezone, 5)` returns upcoming firings,
which is what the schedule dialog previews before you save.

## Catchup

When a scheduler has been down:

- **`catchup: false`** (default) — fire once, now, and move `nextRunAt` past the
  gap. The response reports how many intervals were skipped.
- **`catchup: true`** — fire once per missed interval, capped (50 by default) so
  a week-long outage cannot enqueue thousands of runs by surprise.

## Duplicate protection

Two layers, deliberately:

1. The dispatcher checks for an existing run with the same
   `(scheduleId, logicalDate)`.
2. The database has a unique index on exactly that pair.

The first is the fast path; the second is the guarantee. A scheduler that fires
twice during a failover must not double-charge anybody.

## Backfills

```json
{
  "pipelineId": "pipe_123",
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-03-31T00:00:00Z",
  "intervalSeconds": 86400,
  "concurrency": 2
}
```

Each logical date becomes a run with `trigger: "backfill"` and that date as its
`logicalDate`, so `{{ run.date }}` resolves to the day being replayed rather than
today.

Progress is real:

```text
daily-sales
2026-01-01 → 2026-03-31

90 runs
54 completed
2 failed
34 remaining
2 currently running
```

### Guard rails

- `concurrency` caps how many logical dates run at once (max 20). Backfills hit
  production systems; the default is 1.
- More than 100 runs requires explicit confirmation.
- More than 10,000 runs is refused outright.
- `from` must be in the past — a backfill replays history.

```text
This backfill would create 121 runs. Re-submit with confirmation to proceed.
```

Backfills can be paused, resumed and cancelled. Cancelling clears the pending
dates; runs already dispatched finish on their own.

## Who dispatches

The worker, on a timer (15 s by default), when `WORKER_RUN_SCHEDULER` is not
`false`. In a fleet, every worker runs the tick; `claimDueSchedules` uses
`FOR UPDATE SKIP LOCKED`, and the duplicate index closes the race. You can
dedicate one worker to scheduling by starting the rest with
`WORKER_RUN_SCHEDULER=false`.

In development the embedded worker inside the web process does this, so schedules
fire with nothing else running.

## Programmatically

```ts
import { nextCronOccurrence, describeCron, planBackfill } from "@dataflow-studio/scheduler";

nextCronOccurrence("0 2 * * *", new Date(), "Europe/Berlin");  // → Date
describeCron("0 2 * * 1", "Europe/Berlin");                    // "Every Monday at 02:00 Europe/Berlin"
planBackfill({ from, to, intervalSeconds: 86_400, concurrency: 2, /* … */ });
```
