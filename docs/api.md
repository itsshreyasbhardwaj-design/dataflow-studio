# REST API

Base path `/api/v1`. Every response is JSON. Every request is authenticated,
rate limited, authorized against the caller's role, and audited if it mutates.

## Authentication

```bash
curl -H "Authorization: Bearer dfs_live_..." https://dataflow.example.com/api/v1/pipelines
```

Browser sessions authenticate with the session cookie. Create an API key in
**Settings → API keys**, or with `POST /api/v1/api-keys`. The value is shown once.

## Conventions

- **Pagination** is keyset-based: pass `limit` (max 200) and the `nextCursor`
  from the previous page. Cursors stay valid as new rows arrive.
- **Request IDs**: send `X-Request-Id` to correlate your logs with ours, or read
  the one we generate from the response header. It appears in every error and in
  the audit log.
- **Errors** share one envelope:

```json
{ "error": { "code": "validation_failed", "message": "Pipeline cannot run", "details": { "issues": [] }, "requestId": "req_..." } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | Missing, invalid, revoked or expired credential |
| 403 | `forbidden` | Authenticated, but the role lacks the permission |
| 404 | `not_found` | Does not exist, or belongs to another organization |
| 409 | `conflict` | Name taken, or the resource is in a state that forbids this |
| 413 | `payload_too_large` | Body over 8 MB |
| 415 | `unsupported_media_type` | Not `application/json` |
| 422 | `validation_failed` | Well-formed but invalid; `details.issues` lists why |
| 429 | `rate_limited` | With `Retry-After` |
| 500 | `internal_error` | Message is deliberately generic; use the request ID |

Rate limits: 600/min default, 60/min for run creation, 120/min for writes.
Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

## Endpoints

### Meta

```text
GET  /api/v1/health          no authentication; liveness and store driver
GET  /api/v1/me              principal, role and granted permissions
GET  /api/v1/node-types      the node registry, including field schemas
GET  /api/v1/templates       shipped pipeline templates
```

### Pipelines

```text
GET    /api/v1/pipelines                    ?search= &tag= &limit= &cursor=
POST   /api/v1/pipelines                    { name, description?, definition?, tags? }
GET    /api/v1/pipelines/:id
PATCH  /api/v1/pipelines/:id                { description?, definition?, tags?, archived? }
DELETE /api/v1/pipelines/:id
POST   /api/v1/pipelines/:id/validate
POST   /api/v1/validate                     { definition }        validate without saving
POST   /api/v1/pipelines/:id/publish        { versionId? }
POST   /api/v1/pipelines/:id/run            { params?, logicalDate?, useDraft? }
GET    /api/v1/pipelines/:id/runs
GET    /api/v1/pipelines/:id/compare        ?from=1&to=2
POST   /api/v1/pipelines/from-template      { templateId, name? }
```

`PATCH` with a `definition` writes a **draft**; it never modifies a published
version. `POST /run` uses the published version unless `useDraft` is set, and
refuses if validation fails:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Pipeline cannot run\n\nError [aggregate_sales]: Node \"aggregate_sales\" requires input from \"clean_sales\". The dependency is missing.",
    "details": { "issues": [{ "code": "dependency.not_upstream", "nodeId": "aggregate_sales", "hint": "Connect \"clean_sales\" to \"aggregate_sales\"…" }] },
    "requestId": "req_..."
  }
}
```

### Runs

```text
GET  /api/v1/runs                          ?pipelineId= &state= &trigger= &backfillId= &since=
GET  /api/v1/runs/:id                      run, tasks, graph, quality results
POST /api/v1/runs/:id/cancel
POST /api/v1/runs/:id/retry                { fromNodes?, allNodes? }
GET  /api/v1/runs/:id/logs                 ?taskRunId= &level= &search= &limit= &cursor=
GET  /api/v1/runs/:id/tasks/:taskId        attempts, logs, masked config
POST /api/v1/runs/:id/tasks/:taskId/cancel
GET  /api/v1/runs/:id/investigate          evidence for a failed run
GET  /api/v1/runs/:id/events               server-sent events
```

`/events` streams `run.queued`, `run.started`, `task.queued`, `task.started`,
`task.finished`, `task.retrying`, `task.blocked`, `task.skipped`, `quality` and
`run.finished`. Each carries an `id` (the run's event sequence); send
`Last-Event-ID` to resume without gaps.

```js
const stream = new EventSource("/api/v1/runs/run_123/events");
stream.addEventListener("task.finished", (event) => console.log(JSON.parse(event.data)));
```

### Connections and secrets

```text
GET    /api/v1/connections
POST   /api/v1/connections        { name, family, config?, secretRefs? }
GET    /api/v1/connections/:id
PATCH  /api/v1/connections/:id
DELETE /api/v1/connections/:id
POST   /api/v1/connections/:id/test

GET    /api/v1/secrets            metadata only
POST   /api/v1/secrets            { name, value, description? }
DELETE /api/v1/secrets/:name
```

There is no endpoint that returns a secret value. `POST /connections` rejects a
credential embedded in `config`; use `secretRefs`.

### Scheduling

```text
GET    /api/v1/schedules          ?pipelineId=
POST   /api/v1/schedules          { pipelineId, kind, cron?|intervalSeconds?, timezone?, catchup? }
PATCH  /api/v1/schedules/:id
DELETE /api/v1/schedules/:id

GET    /api/v1/backfills          ?pipelineId=
POST   /api/v1/backfills          { pipelineId, from, to, intervalSeconds?|cron?, concurrency?, confirmLargeBackfill? }
GET    /api/v1/backfills/:id
POST   /api/v1/backfills/:id/state { state: "running" | "paused" | "cancelled" }
```

### Catalog and analysis

```text
GET   /api/v1/datasets            ?search=
GET   /api/v1/datasets/:name      schema history, quality, lineage, preview
GET   /api/v1/lineage             ?pipelineId=
GET   /api/v1/incidents           ?status= &kind=
PATCH /api/v1/incidents/:id       { status }
GET   /api/v1/search              ?q= &limit=
GET   /api/v1/dashboard           ?days=
GET   /api/v1/analytics           ?from= &to= &pipelineId=
GET   /api/v1/audit               ?action= &resourceType=
```

### Preview and demo

```text
POST /api/v1/preview/source       { nodeType, config, limit? }   reads a bounded sample
POST /api/v1/preview/sql          { query, inputs }              runs a transform on sample rows
POST /api/v1/preview/quality      { checks, rows }               evaluates checks on sample rows
POST /api/v1/demo/seed            { execute?, templateIds? }
```

### API keys

```text
GET    /api/v1/api-keys
POST   /api/v1/api-keys           { name, role, expiresInDays?, environment? }
DELETE /api/v1/api-keys/:id       revoke
```

## A worked example

```bash
API=https://dataflow.example.com
KEY=dfs_live_...

PIPELINE=$(curl -sX POST $API/api/v1/pipelines -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d @examples/pipelines/daily-sales.json | jq -r .pipeline.id)

curl -sX POST $API/api/v1/pipelines/$PIPELINE/publish -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{}' | jq .version.version

RUN=$(curl -sX POST $API/api/v1/pipelines/$PIPELINE/run -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{}' | jq -r .id)

curl -sN $API/api/v1/runs/$RUN/events -H "Authorization: Bearer $KEY"
```

Or use the [SDK](sdk.md) or the [CLI](cli.md), which wrap exactly these calls.
