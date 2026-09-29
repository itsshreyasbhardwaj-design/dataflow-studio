# Contributing

Thank you for considering it. This document is short and specific, because the
useful part of a contributing guide is the part that tells you where things live
and what will get your PR sent back.

## Getting set up

```bash
git clone https://github.com/itsshreyasbhardwaj-design/dataflow-studio
cd dataflow-studio
pnpm install
pnpm run build:packages   # the app imports built packages
pnpm dev                  # http://localhost:3000
```

No database, no Redis, no accounts. The default store is in-memory and the web
process runs an embedded worker, so a pipeline you create actually executes.

To work against PostgreSQL:

```bash
docker run -d --name dataflow-pg -p 5432:5432 \
  -e POSTGRES_USER=dataflow -e POSTGRES_PASSWORD=dataflow -e POSTGRES_DB=dataflow \
  postgres:16-alpine
export DATABASE_URL=postgresql://dataflow:dataflow@localhost:5432/dataflow
pnpm dev                   # migrations run on first connect
pnpm worker                # in another terminal - the embedded worker turns off
```

## Where things live

| Package | Responsibility |
| --- | --- |
| `packages/workflow-engine` | Definition format, node registry, DAG algorithms, validation, versioning, retry policy. No I/O. |
| `packages/execution-engine` | Executing one task, advancing a run, retries, cancellation, incidents. |
| `packages/database` | The `Store` contract and its two drivers. Tenancy is enforced here. |
| `packages/connectors` | Everything that talks to an external system, plus the egress policy. |
| `packages/transformations` | The SQL engine and the filter/aggregate/join nodes. |
| `packages/data-quality` | Checks and gates. |
| `packages/schema-registry` | Type inference, profiling, schema evolution rules. |
| `packages/scheduler` | Cron parsing, schedule advancement, backfill planning. |
| `apps/api` | Authentication, RBAC, rate limiting, the service layer, the router. |
| `apps/worker` | The claim loop and the timers. |
| `apps/web` | Next.js application. Calls the service layer directly on the server. |
| `apps/cli` | `dataflow`. Depends only on the SDK. |

Two rules keep this tidy:

1. **Business logic does not live in route handlers or React components.** A
   route handler parses input and calls a service function. If you find yourself
   writing a `for` loop in `route.ts`, it belongs in `apps/api/src/services`.
2. **The engine does not import the API, and the API does not import the web
   app.** Dependencies point one way.

## Adding a node type

This is the most common contribution, and it is deliberately a small diff:

1. Add an entry to `packages/workflow-engine/src/node-types.ts`. The field schema
   you declare is what the validator enforces, what the editor renders, and what
   the docs table is generated from. Declare `destructive: true` if it writes to
   an external system.
2. Add an executor in `packages/execution-engine/src/executors.ts` and register
   it in the map at the bottom of the file.
3. If it talks to a new system, implement `DataConnector` in
   `packages/connectors` and add it to `ConnectorRegistry.forNodeType`.
4. Write tests: at least one that the node does the right thing, and one for what
   it does with bad configuration.

## Testing

```bash
pnpm test                  # unit + integration (fast, no services)
pnpm vitest run packages/transformations   # one package
pnpm test:e2e              # Playwright against a production build
```

A few expectations:

- **A bug fix comes with a test that fails without the fix.** If you cannot write
  one, say so in the PR and explain why.
- **Store changes run against both drivers.** `packages/database/src/store.test.ts`
  is one conformance suite that both the in-memory and PostgreSQL drivers must
  satisfy. CI runs it against a real PostgreSQL service container.
- **Security-relevant changes get an adversarial test** in `tests/security.test.ts`,
  written as the attack rather than as the guard.
- Tests should not need network access, a clock that moves, or a sleep. Inject a
  clock instead; most modules already take one.

## Style

- TypeScript strict mode, no `any` in production code without a comment saying
  why.
- Comments explain *why*, not *what*. If the code needs a comment to say what it
  does, rename something instead.
- Errors that a user will read are written for that user: what went wrong, and
  what to do about it. `"relation \"sales\" does not exist"` is a fine message;
  `"Error: undefined"` is not.
- Run `pnpm lint` and `pnpm typecheck` before pushing. Both are clean on `main`
  and CI enforces it.

## Pull requests

Small and focused beats large and comprehensive. If a change touches execution
semantics, the database schema, or anything under `apps/api/src/auth.ts`,
`rbac.ts` or `packages/connectors/src/ssrf.ts`, say so explicitly in the PR
description - those get a closer read.

Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`security:`) are used for the changelog.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
