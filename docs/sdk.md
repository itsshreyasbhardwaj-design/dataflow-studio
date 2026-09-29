# TypeScript SDK

```bash
pnpm add @dataflow-studio/sdk
```

```ts
import { DataFlowClient } from "@dataflow-studio/sdk";

const client = new DataFlowClient({
  baseUrl: "https://dataflow.example.com",
  apiKey: process.env.DATAFLOW_API_KEY,
});

const pipelines = await client.pipelines.list();
const run = await client.pipelines.run("pipe_123");
const finished = await client.runs.waitFor(run.id);
```

`baseUrl` defaults to `DATAFLOW_API_URL`, `apiKey` to `DATAFLOW_API_KEY`.

## Transport

Retries are limited to what is safe to retry: a `429` or `5xx` on a `GET`, or any
request you tag with an idempotency key. Backoff is exponential and honours
`Retry-After`. Every failure throws a `DataFlowApiError` carrying `status`,
`code`, the server's `requestId` and, for validation failures, the individual
issues:

```ts
import { DataFlowApiError } from "@dataflow-studio/sdk";

try {
  await client.pipelines.publish(id);
} catch (error) {
  if (error instanceof DataFlowApiError && error.code === "validation_failed") {
    for (const issue of (error.details as { issues: Array<{ message: string }> }).issues) {
      console.error(issue.message);
    }
  }
  throw error;
}
```

## Surface

```ts
client.me.get()

client.pipelines.list({ search, limit, cursor })
client.pipelines.get(id)
client.pipelines.create({ name, definition })
client.pipelines.update(id, { definition })
client.pipelines.delete(id)
client.pipelines.validate(idOrDefinition)
client.pipelines.publish(id)
client.pipelines.run(id, { params, logicalDate, useDraft })
client.pipelines.runs(id, { state })
client.pipelines.compare(id, 1, 2)
client.pipelines.fromTemplate(templateId, name)

client.runs.list({ pipelineId, state, since })
client.runs.get(runId)
client.runs.cancel(runId)
client.runs.retry(runId, { allNodes })
client.runs.logs(runId, { level, search, taskRunId })
client.runs.task(runId, taskId)
client.runs.investigate(runId)
client.runs.stream(runId, { signal, lastEventId })
client.runs.waitFor(runId, { timeoutMs, pollMs, onUpdate })

client.datasets.list() / get(name)
client.lineage.get({ pipelineId })
client.schedules.list() / create() / update() / delete()
client.backfills.list() / create() / get() / setState()
client.connections.list() / create() / test() / delete()
client.secrets.list() / create(name, value) / delete(name)
client.incidents.list({ status }) / update(id, status)
client.analytics.dashboard(days) / runs({ from, to })
client.search.query(q)
client.health.check()
```

`client.raw` exposes the underlying HTTP client for endpoints the typed surface
does not cover yet.

## Waiting for a run

`waitFor` is what CI uses: it polls until the run is terminal and returns it, so
the caller decides what a failure means.

```ts
const run = await client.pipelines.run("pipe_123", { params: { region: "north" } });

const finished = await client.runs.waitFor(run.id, {
  timeoutMs: 30 * 60_000,
  onUpdate: (current) => console.log(current.state),
});

if (finished.state !== "SUCCESS") {
  const { tasks } = await client.runs.get(finished.id);
  for (const task of tasks.filter((t) => t.state === "FAILED")) {
    console.error(`${task.nodeId}: ${task.error}`);
  }
  process.exit(1);
}
```

## Streaming a live run

```ts
const controller = new AbortController();

for await (const event of client.runs.stream(runId, { signal: controller.signal })) {
  if (event.type === "task.finished") {
    console.log(event.data.nodeId, event.data.state);
  }
  if (event.type === "run.finished") break;
}
```

Pass `lastEventId` to resume after a disconnect without missing events.

## Deploying from code

```ts
import { readFile } from "node:fs/promises";
import { DataFlowClient } from "@dataflow-studio/sdk";

const client = new DataFlowClient();
const definition = JSON.parse(await readFile("pipelines/daily-sales.json", "utf8"));

const validation = await client.pipelines.validate(definition);
if (!validation.valid) {
  for (const issue of validation.errors) console.error(issue.nodeId, issue.message);
  process.exit(2);
}

const existing = (await client.pipelines.list({ search: definition.name })).items
  .find((candidate) => candidate.name === definition.name);

const detail = existing
  ? await client.pipelines.update(existing.id, { definition })
  : await client.pipelines.create({ name: definition.name, definition });

if (process.env.CI_PUBLISH === "true") {
  const published = await client.pipelines.publish(detail.pipeline.id);
  console.log(`published v${published.version.version}`);
}
```

## Types

The SDK ships its own types and does not require the engine packages. Import
`WorkflowDefinition` from it when you build definitions programmatically.
