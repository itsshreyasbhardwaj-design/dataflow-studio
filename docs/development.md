# Development

## Setup

```bash
pnpm install
pnpm run build:packages   # the app imports built packages
pnpm dev                  # http://localhost:3000
```

Requires Node 20.11+ and pnpm 11. Nothing else — no database, no Docker.

Seed something to look at:

```bash
pnpm seed                 # demo pipeline, executed
pnpm seed -- --runs 5     # several runs, so the charts have shape
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web app with an embedded worker |
| `pnpm worker` | Standalone worker (needs `DATABASE_URL`) |
| `pnpm build` | Build every package and the app |
| `pnpm build:packages` | Build the libraries the app imports (`packages/*`, `apps/api`, `apps/worker`) |
| `pnpm typecheck` | Project-wide `tsc -b` |
| `pnpm lint` / `pnpm lint:fix` | ESLint |
| `pnpm test` | Unit and integration tests |
| `pnpm test:watch` | Watch mode |
| `pnpm test:e2e` | Playwright against a production build |

Tests import package **sources** through Vitest aliases, so there is no build
step between editing and running them. The app imports built output — the workspace packages plus
`apps/api` and `apps/worker` — which is why `build:packages` matters after
changing any of them.

## Layout

```text
apps/
  web/      Next.js: pages, components, the editor
  api/      Service layer, auth, RBAC, router. Also a standalone server.
  worker/   Claim loop and timers
  cli/      dataflow
packages/
  workflow-engine/    definition, registry, validation, DAG, versioning, retry
  execution-engine/   planning, task execution, advancing runs, incidents
  database/           Store contract + memory and PostgreSQL drivers
  connectors/         external I/O and the egress policy
  transformations/    SQL engine, filter, aggregate, join
  data-quality/       checks and gates
  schema-registry/    inference, profiling, evolution rules
  lineage/            dataset graph
  scheduler/          cron, schedules, backfills
  secrets/            encryption, resolution, masking
  observability/      logging, redaction, metrics, IDs
  sdk/ api-client/    the published client
tests/                cross-package integration, security, E2E
docs/
examples/pipelines/
```

## Working against PostgreSQL

`pg` is an optional peer dependency of `@dataflow-studio/database` and a
dev dependency of this workspace, so `pnpm install` already provides it here.
Production images install it themselves - see [self-hosting](./self-hosting.md).

```bash
docker run -d --name dataflow-pg -p 5432:5432 \
  -e POSTGRES_USER=dataflow -e POSTGRES_PASSWORD=dataflow -e POSTGRES_DB=dataflow \
  postgres:16-alpine

export DATABASE_URL=postgresql://dataflow:dataflow@localhost:5432/dataflow
pnpm dev      # migrations run on connect; the embedded worker turns itself off
pnpm worker   # in another terminal
```

To run the store conformance suite against it:

```bash
TEST_DATABASE_URL=postgresql://dataflow:dataflow@localhost:5432/dataflow \
  pnpm vitest run packages/database
```

The same suite runs against both drivers, which is what keeps the in-memory one
honest.

## Adding things

**A node type** — one registry entry in
`packages/workflow-engine/src/node-types.ts`, one executor in
`packages/execution-engine/src/executors.ts`, registered in the map at the
bottom. The field schema you declare drives validation, the editor's form and the
docs. See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-node-type).

**A connector** — implement `DataConnector`, add node types, register it in
`ConnectorRegistry.forNodeType`, and map the system's error codes to error
classes so retries behave.

**A store method** — add it to the `Store` interface, implement it in both
drivers, and extend the conformance suite. The interface is the contract; a
method that only one driver implements is a bug waiting for production.

**A quality check** — add the type to `CHECK_TYPES`, validate its options in
`parseChecks`, implement the evaluation in `evaluateCheck`. Every check reports
`passedRows`, `failedRows`, `totalRows` and samples.

## Testing conventions

- A bug fix comes with a test that fails without the fix.
- Time is injected. Modules take a `clock`; tests pass a fixed `Date`. No sleeps
  except where the thing under test is a timeout.
- Network is stubbed. `vi.stubGlobal("fetch", …)` or the in-memory drivers.
- Security-relevant changes get an adversarial test in `tests/security.test.ts`,
  written as the attack rather than as the guard.
- Integration tests go through the HTTP handler and the worker's claim loop, not
  through internal shortcuts.

## Debugging

```bash
LOG_LEVEL=debug pnpm dev
```

Every log line carries the run, task, node, attempt and worker. In the product,
the run page's Logs tab filters by level, task and free text, and
`/api/v1/runs/:id/investigate` returns the evidence for a failure.

```bash
curl -s localhost:3000/api/v1/runs/run_123/investigate | jq
curl -s localhost:3002/metrics
```

## Things worth knowing

- **The web app's runtime singleton lives on `globalThis`.** Next instantiates
  modules once per graph; a module-level cache produced two stores, so a run
  created through the API was invisible to the page rendering it.
- **`packages/workflow-engine` must stay isomorphic.** The editor imports it.
  That is why the definition hash uses a TypeScript SHA-256 rather than
  `node:crypto`.
- **Monaco is loaded client-side only**, narrowed to the editor core plus the SQL
  and Python grammars. Importing the full package costs minutes of dev compile
  and megabytes of bundle.
- **`pnpm build:packages` after changing a package.** The app imports `dist`.
