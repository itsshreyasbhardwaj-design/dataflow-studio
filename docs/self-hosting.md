# Self-hosting

## The smallest thing that works

```bash
git clone https://github.com/itsshreyasbhardwaj-design/dataflow-studio
cd dataflow-studio
pnpm install
pnpm run build:packages
pnpm dev
```

`http://localhost:3000`. No database, no queue, no accounts. The store is
in-memory, authentication is a local single user, and the web process runs an
embedded worker — so pipelines you create actually execute.

This is genuinely useful for evaluation and for development, and genuinely
unsuitable for production: state disappears on restart and a separate worker
cannot see it. The dashboard says so.

## Production topology

```text
              ┌──────────────┐
  users ─────▶│  web (N)     │──┐
              └──────────────┘  │
                                ├──▶  PostgreSQL
              ┌──────────────┐  │      (state, queue, catalog)
              │  worker (M)  │──┘
              └──────┬───────┘
                     └──────────▶  your data systems
```

- **web** — Next.js. Serves the UI and the API. Stateless; scale horizontally.
- **worker** — claims and executes tasks. Stateless; scale by task volume.
- **PostgreSQL** — the only stateful component. It is the database *and* the
  queue.

Redis is optional and only shares rate-limit counters between API instances.

## PostgreSQL

```bash
createdb dataflow
export DATABASE_URL=postgresql://dataflow:secret@db.internal:5432/dataflow
```

Migrations run automatically on first connect. To apply them without starting the
app:

```ts
import { createPostgresStore } from "@dataflow-studio/database";
await (await createPostgresStore(process.env.DATABASE_URL)).migrate();
```

The `pg` driver is an optional peer dependency, so a deployment that never uses
PostgreSQL does not ship it:

```bash
pnpm add pg          # in the web and worker images
pnpm add mysql2      # only if you use MySQL connectors
```

A dedicated role with minimal grants:

```sql
CREATE ROLE dataflow_app LOGIN PASSWORD 'secret';
GRANT CONNECT ON DATABASE dataflow TO dataflow_app;
GRANT USAGE ON SCHEMA public TO dataflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dataflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dataflow_app;
```

Run migrations as a role that can create tables, then run the application as
`dataflow_app`. If the database is reachable by anything other than this
application, also apply `0002_row_level_security.sql` with
`DATAFLOW_ENABLE_RLS=true`.

## Required configuration

```bash
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=$(openssl rand -base64 32)   # 32 bytes; losing it makes stored secrets unreadable
AUTH_MODE=clerk
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
NEXT_PUBLIC_APP_URL=https://dataflow.example.com
```

Clerk requires `pnpm add @clerk/nextjs` in `apps/web`; it is an optional
dependency so that self-hosters using another identity provider — or none — do
not carry it. `AUTH_MODE=local` is for development only.

See [`.env.example`](../.env.example) for the full list.

## Docker

```dockerfile
# Dockerfile.web
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm run build:packages && pnpm --filter @dataflow-studio/web run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@dataflow-studio/web", "run", "start"]
```

```dockerfile
# Dockerfile.worker
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build:packages && \
    pnpm --filter @dataflow-studio/worker run build && pnpm add pg
ENV NODE_ENV=production
EXPOSE 3002
CMD ["pnpm", "--filter", "@dataflow-studio/worker", "run", "start"]
```

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: dataflow
      POSTGRES_PASSWORD: dataflow
      POSTGRES_DB: dataflow
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dataflow"]
      interval: 5s

  web:
    build: { context: ., dockerfile: Dockerfile.web }
    environment:
      DATABASE_URL: postgresql://dataflow:dataflow@postgres:5432/dataflow
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY}
      AUTH_MODE: ${AUTH_MODE:-local}
    ports: ["3000:3000"]
    depends_on: { postgres: { condition: service_healthy } }

  worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    environment:
      DATABASE_URL: postgresql://dataflow:dataflow@postgres:5432/dataflow
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY}
      WORKER_CONCURRENCY: 4
    depends_on: { postgres: { condition: service_healthy } }
    deploy: { replicas: 2 }

volumes: { pgdata: }
```

## Scaling

- **More concurrent tasks** — raise `WORKER_CONCURRENCY` or add worker replicas.
  Claiming is atomic, so replicas need no coordination.
- **Heterogeneous pools** — `WORKER_NODE_TYPES=postgres.source,postgres.destination`
  on one pool and `http.source,s3.destination` on another, to keep a slow
  connector from starving fast work.
- **One scheduler** — `WORKER_RUN_SCHEDULER=false` on all but one worker if you
  prefer a single dispatcher. Not required: the duplicate index makes concurrent
  dispatch safe.
- **API instances** — stateless; add replicas behind a load balancer. Set
  `REDIS_URL` so rate limits are shared.

## Operating

| Endpoint | What it tells you |
| --- | --- |
| `GET /api/v1/health` (web) | Liveness and which store driver is active |
| `GET /` (worker, `:3002`) | Worker stats: tasks executed, in flight, leases reclaimed |
| `GET /metrics` (worker) | Prometheus text |

Logs are JSON on stdout, with `organizationId`, `runId`, `taskId`, `nodeId`,
`attempt`, `workerId` and `requestId` on every line. Credentials are redacted at
the sink.

Back up PostgreSQL normally. It holds everything: definitions, run history, logs,
quality results, lineage, audit and encrypted secrets. Keep `ENCRYPTION_KEY`
somewhere else — a backup plus the key in the same place is one compromise, not
two. **Losing the key makes every stored secret unreadable.**

Tables that grow without bound are `task_logs`, `run_events`, `workflow_runs`,
`task_runs`, `task_attempts` and `audit_logs`. A retention job that deletes runs
older than your policy (audit logs excepted, usually) is worth adding early.

## Upgrading

```bash
git pull
pnpm install --frozen-lockfile
pnpm run build:packages
pnpm --filter @dataflow-studio/web run build
# Restart web; migrations run on connect. Restart workers after.
```

Migrations are additive and idempotent. Roll workers after the web tier: an old
worker against a new schema is the safer direction.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worker exits with code 78 | `DATABASE_URL` is not set; a detached worker cannot use the in-memory store. |
| `"pg" driver is not installed` | `pnpm add pg` in the image. |
| Secrets fail to resolve | `ENCRYPTION_KEY` missing or changed. |
| Tasks stuck `QUEUED` | No worker running, or `WORKER_NODE_TYPES` excludes them. |
| Tasks repeatedly reclaimed | `TASK_LEASE_SECONDS` is shorter than the task's real duration. |
| HTTP nodes fail with "Blocked request" | The egress policy is doing its job. Add the host to `CONNECTOR_ALLOWED_HOSTS`. |
| Schedules do not fire | `WORKER_RUN_SCHEDULER=false` on every worker. |
