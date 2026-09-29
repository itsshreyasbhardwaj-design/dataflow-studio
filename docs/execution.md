# Execution

How a pipeline actually runs: states, claiming, retries, cancellation and
recovery.

## States

**Tasks**

```text
PENDING ──▶ QUEUED ──▶ RUNNING ──┬──▶ SUCCESS
   │           │          │      ├──▶ RETRYING ──▶ QUEUED
   │           │          │      ├──▶ FAILED
   │           │          └──────┴──▶ CANCELLED
   ├──▶ SKIPPED     (an upstream task did not succeed, or a branch was not taken)
   └──▶ BLOCKED     (an upstream quality gate blocked downstream execution)
```

**Runs**

```text
QUEUED ──▶ RUNNING ──┬──▶ SUCCESS     every task terminal, none failed or blocked
                     ├──▶ FAILED      a task failed, was blocked, or was cancelled
                     └──▶ CANCELLED   the run itself was cancelled
```

A single cancelled task fails the run rather than succeeding it: the pipeline did
not do what it was asked to do. Only a run-level cancellation reports
`CANCELLED`.

## Planning

`planRun` turns a definition into rows:

- One `workflow_runs` row with the trigger, the actor, the logical date and the
  version that will execute.
- One `task_runs` row per node. Roots start `QUEUED`; the rest start `PENDING`
  with `dependsOn` denormalized onto the row, so readiness can be decided without
  re-reading the definition.
- `priority` is derived from the topological layer, so upstream work is claimed
  before downstream work when a worker pool is saturated.

## Claiming

A worker's entire loop is: claim a task, run it, repeat.

```sql
UPDATE task_runs
SET state = 'RUNNING', worker_id = $1, lease_expires_at = $2,
    started_at = coalesce(started_at, $3)
WHERE id = (
  SELECT id FROM task_runs
  WHERE state IN ('QUEUED', 'RETRYING') AND scheduled_at <= $3
    AND ($4::text[] IS NULL OR node_type = ANY($4))
  ORDER BY priority DESC, scheduled_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`SKIP LOCKED` is what makes horizontal scaling safe: two workers racing for the
same row take different rows instead of blocking or double-running. No broker, no
distributed lock, no leader election.

`WORKER_NODE_TYPES` restricts a worker to specific node types, which is how you
run a pool with database drivers separately from a pool that only does HTTP.

## Leases and crash recovery

A claim sets `lease_expires_at`. While a task runs, the worker renews it on a
heartbeat (every 15 seconds by default) and, on the same beat, checks whether
cancellation was requested.

If a worker dies, its lease lapses. Any worker's `reclaimExpiredLeases` returns
those tasks to `QUEUED` and calls `advanceRun`, so the run continues. The trade
is explicit: a task may run twice if a worker is partitioned rather than dead,
which is exactly why destructive nodes are not retried unless they declare
themselves idempotent.

Set `TASK_LEASE_SECONDS` above your longest task. Too short means spurious
reclaims; too long means slow recovery.

## Executing one task

`runTask` is one attempt:

1. Refuse immediately if the run is cancelling.
2. Load the version and the node. A version that no longer exists fails the task
   rather than guessing.
3. Resolve configuration: apply registry defaults, merge the stored connection's
   settings, and decrypt secret references. Every secret read is audited.
4. Gather upstream batches from the task data plane.
5. Run the executor with an `AbortSignal` wired to the node's timeout and to
   cancellation.
6. Persist: output batch, quality results, dataset catalog entry, log lines, the
   attempt row, and the task state.
7. Call `advanceRun`.

Failures are classified and handed to `planRetry`. A retry sets `RETRYING` with
`scheduled_at` in the future; the claim query will not pick it up before then.

## Advancing a run

`advanceRun` decides what becomes runnable. For each `PENDING` task:

| Upstream state | Result |
| --- | --- |
| All `SUCCESS` | `QUEUED` |
| Any still running or pending | wait |
| Any `FAILED` (without `continueOnFailure`), `CANCELLED` or `SKIPPED` | `SKIPPED` |
| Any `BLOCKED`, or a gate that blocked downstream | `BLOCKED` |
| Upstream is a condition node whose selected port differs | `SKIPPED` |

The sweep repeats until nothing changes, so skipping cascades through the whole
graph in one call. It is idempotent and safe to call from several workers at
once, which matters because every worker calls it after every task.

When all tasks are terminal it writes the final state, totals and duration,
deletes the run's intermediate data, and runs incident detection.

## The data plane between tasks

Output batches are written to `task_data` keyed by `(organization, run, node)`.
A downstream task on any worker reads them from there. A hard cap
(`maxBatchBytes`, 32 MB) applies; exceeding it fails the task with:

```text
Node "extract" produced 41 MB of intermediate data, over the 32 MB limit.
Write to a destination and read it back, or add a limit.
```

That message is the honest one: the control plane is not a shuffle engine.

## Cancellation

`cancelRun` records the request, cancels every queued or retrying task
immediately, and lets running tasks observe it at their next heartbeat and abort
through their `AbortSignal`. Executors that do long work (`delay.wait`, HTTP
requests, database queries) are wired to that signal.

The run is only marked `CANCELLED` once every task is terminal, so the UI never
shows a cancelled run while a task is still writing to a warehouse.

`cancelTask` cancels one task; `advanceRun` then skips its dependents.

## Retrying a run

`retryRun` creates a **new** run rather than mutating history. By default it
re-runs the nodes that did not succeed, plus their ancestors (a re-run needs its
inputs; the previous run's intermediate data has been released) and their
descendants (those results are now invalid). Everything else is `SKIPPED`, so the
run page shows exactly what was re-done. `allNodes: true` re-runs everything.

The new run records `retryOfRunId`, and the UI links back.

## Incidents

After a run finishes, detectors compare it against stored history. Each opens an
incident with the evidence it used, deduplicated by fingerprint so a recurring
condition bumps a counter instead of flooding the list.

| Detector | Condition | Evidence recorded |
| --- | --- | --- |
| `repeated_failure` | 3 consecutive failed runs | Run IDs, first failure, last error |
| `duration_spike` | Run > 2× the recent average (≥ 5 samples, > 30 s) | Duration, average, sample size, multiplier |
| `quality_failure` | Any failing check | Each check with expected, actual, failed rows |
| `schema_change` | `WARNING` or `BREAKING` drift | Classification, change count, node |
| `missing_data` | A source read 0 rows *after previously reading some* | Node, node type, run |
| `stale_dataset` | Not refreshed in 2× its schedule interval | Dataset, last update, expected interval |

No detector speculates about a cause. `missing_data` deliberately stays quiet on
a brand-new pipeline: zero rows on a first run is not yet evidence of anything.

## Investigating a failure

`gatherFailureEvidence` collects what a human needs and stops there: the first
failed task, its attempts, its logs, the last successful run, the definition diff
since that run, the quality failures, the blast radius, and whether this node has
failed before. It presents facts and leaves the conclusion to the reader — which
is also what the optional AI assistant is given, and nothing more.

## Metrics

The worker exposes Prometheus text on `:3002/metrics`:

```text
dataflow_tasks_total{node_type,state}
dataflow_task_retries_total{node_type,error_class}
dataflow_task_duration_seconds{node_type}
dataflow_runs_started_total{pipeline,trigger}
dataflow_runs_finished_total{pipeline,state}
dataflow_run_duration_seconds{pipeline}
dataflow_leases_reclaimed_total
dataflow_worker_in_flight{worker}
```

Every log line carries `organizationId`, `runId`, `taskId`, `nodeId`, `attempt`
and `workerId`, so a single query joins a log line to the task, the run and the
pipeline version that produced it.
