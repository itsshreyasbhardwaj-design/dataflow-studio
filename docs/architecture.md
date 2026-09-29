# Architecture

DataFlow Studio is a control plane for data workflows. It separates *defining* a
pipeline from *executing* it, and it keeps the execution state in one place so
that the UI, the API, the CLI and the workers all agree about what happened.

## The shape of the system

```text
                    ┌──────────────────────────────────────────┐
  browser  ────────▶│  apps/web (Next.js)                      │
                    │    server components ─┐                  │
                    │    /api/v1/*  ────────┤                  │
  CLI / SDK ───────▶│                       ▼                  │
                    │            apps/api (service layer)      │
                    │      auth · RBAC · rate limit · audit    │
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │  packages/database — the Store contract  │
                    │  in-memory driver  |  PostgreSQL driver  │
                    └───────────────┬──────────────────────────┘
                                    │  claim / update / append
                    ┌───────────────▼──────────────────────────┐
  apps/worker ─────▶│  packages/execution-engine               │
   (1..N)           │  plan · execute one task · advance run   │
                    └───────────────┬──────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
  connectors                 transformations                data-quality
  (external I/O)             (SQL, filter, join)            (checks, gates)
```

Nothing in the diagram is optional scaffolding. The web app is the only piece a
user sees; every other box has its own tests and can be exercised on its own.

## The ten separations

The brief for this project asked for ten things to be kept apart. They are, and
here is where each one lives:

| Concern | Where | Why it is separate |
| --- | --- | --- |
| Workflow definition | `packages/workflow-engine` | Pure data and pure functions. No I/O, so it runs in the browser too. |
| Workflow execution | `packages/execution-engine` (`advanceRun`) | Decides what becomes runnable; knows nothing about *how* a node runs. |
| Task execution | `packages/execution-engine` (`runTask`, `executors.ts`) | One attempt of one node. The only place a connector is called. |
| Scheduling | `packages/scheduler` | Cron and interval arithmetic with no database access; the worker supplies the clock and the store. |
| State management | `packages/database` | The only module that persists anything. Tenancy is enforced here. |
| Data quality | `packages/data-quality` | Checks and gates as values, so they can be previewed before a run. |
| Observability | `packages/observability` | Logging, redaction, metrics, correlation IDs. Imported by everything, imports nothing. |
| Secrets | `packages/secrets` | Encryption, resolution and masking, behind a provider interface. |
| Metadata | `packages/schema-registry`, `packages/lineage` | Schema history and lineage are derived, not hand-maintained. |
| UI | `apps/web` | Renders state. Never executes a workflow. |

**The frontend never executes a workflow.** A "Run" button issues
`POST /api/v1/pipelines/:id/run`, which creates a run and its task rows. From
there a worker picks the work up. The browser learns what happened by
subscribing to the run's event stream.

## Why one store contract, two drivers

`packages/database/src/store.ts` defines about fifty organization-scoped methods.
Two drivers implement it:

- **In-memory** — the default. Development, tests, and single-process
  self-hosting. Not durable, not shared between processes.
- **PostgreSQL** — production. Migrations, foreign keys, partial indexes,
  `FOR UPDATE SKIP LOCKED` task claiming, and optional row-level security.

One conformance suite runs against both (`packages/database/src/store.test.ts`),
and CI runs it against a real PostgreSQL container. That is what makes the
in-memory driver trustworthy rather than a toy: the execution engine cannot tell
them apart, so a pipeline behaves identically either way.

`capabilitiesOf(store)` reports `multiProcess` and `durable`. The worker refuses
to start detached when the store is in-memory, and the dashboard says so, because
a worker that silently sees an empty queue is worse than one that will not boot.

## How a run actually happens

1. `POST /api/v1/pipelines/:id/run` validates the published version, then calls
   `planRun`. That produces one `workflow_runs` row and one `task_runs` row per
   node. Root tasks start `QUEUED`; everything else starts `PENDING` with its
   dependencies denormalized onto the row.
2. A worker calls `claimNextTask`. In PostgreSQL that is a single `UPDATE ...
   WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, which is
   why N workers never collide and never block each other.
3. The worker calls `runTask`. It resolves the node's configuration (merging the
   stored connection and decrypting secret references), gathers upstream batches,
   runs the executor, and writes the result: task state, an attempt row, log
   lines, quality results, and the output batch for downstream nodes.
4. `advanceRun` sweeps the run: dependencies satisfied → `QUEUED`; an upstream
   failure → `SKIPPED`; an upstream quality gate that blocked → `BLOCKED`. It
   repeats until nothing changes, so a skip cascades through the whole graph in
   one pass. When every task is terminal it finalises the run and runs incident
   detection.
5. The browser sees each of those transitions as a server-sent event.

Steps 2–4 are idempotent and safe to run concurrently. That is the property that
makes horizontal scaling work.

## The data plane

Batches passed between tasks go through the store (`task_data`), not through
process memory, because the next task may run on a different worker. There is a
hard byte cap (`maxBatchBytes`, 32 MB by default): a node that produces more than
that fails with a message telling the author to write to a destination and read
it back. Rows are deleted when the run finishes.

This is a deliberate trade. It makes multi-worker execution correct for moderate
volumes and keeps the control plane simple. It is not a shuffle engine — see
[Known limitations](../README.md#known-limitations).

## Failure model

| Failure | What happens |
| --- | --- |
| Task throws | Classified (`timeout`, `connection`, `rate_limit`, …). Retried per policy, or failed. |
| Task exceeds its timeout | Aborted through an `AbortSignal`; classified `timeout`. |
| Worker crashes mid-task | Its lease expires; another worker reclaims the task and re-runs it. |
| Worker crashes mid-run | Other workers continue; `advanceRun` is idempotent. |
| Database unavailable | Workers fail their claims and retry; no state is invented. |
| Destructive write fails | Not retried unless the node declares `idempotent: true`. |
| Quality gate fails | Downstream tasks are `BLOCKED`, not failed. The run fails; nothing was written. |
| Cancellation requested | Queued tasks cancel immediately; running tasks abort at their next heartbeat. |

## Request path

Every HTTP request — from the browser, the CLI, the SDK or `curl` — goes through
`createApiHandler`: request ID, authentication, rate limit, route match, handler,
audit, error envelope. Server components skip the HTTP hop and call the same
service functions with the same `ApiContext`, so permission checks are one code
path rather than two.

## What is deliberately not here

- **No message broker.** The queue is the `task_runs` table. It is transactional,
  inspectable with SQL, and survives a restart. A broker would add an operational
  dependency and a second source of truth.
- **No workflow DSL.** Definitions are JSON. The editor, the CLI and generated
  code all produce the same thing, and `git diff` works on it.
- **No plugin runtime.** New node types are a registry entry and an executor,
  compiled with the rest. That is a deliberate limit on blast radius.

See [`execution.md`](execution.md) for state transitions,
[`security.md`](security.md) for the trust boundaries, and
[`self-hosting.md`](self-hosting.md) for deployment topologies.
