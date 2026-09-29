# Workflow engine

`packages/workflow-engine` owns the definition format and everything that can be
decided about a pipeline without running it. It performs no I/O, which is why the
same code validates in the browser, in the API and in CI.

## The definition format

```json
{
  "name": "daily-sales",
  "version": 3,
  "description": "Optional.",
  "nodes": [
    {
      "id": "extract",
      "type": "postgres.source",
      "config": { "connectionId": "conn_123", "mode": "table", "table": "public.sales" },
      "retry": { "maxAttempts": 3, "strategy": "exponential", "initialDelaySeconds": 5, "multiplier": 6 },
      "timeoutSeconds": 900,
      "continueOnFailure": false,
      "metadata": { "label": "Extract sales", "position": { "x": 0, "y": 0 } }
    },
    { "id": "transform", "type": "sql.transform", "config": { "query": "SELECT * FROM input" } }
  ],
  "edges": [{ "from": "extract", "to": "transform" }],
  "params": { "region": "north" },
  "defaults": { "retry": { "maxAttempts": 2, "strategy": "fixed" }, "timeoutSeconds": 3600 }
}
```

`metadata` is presentational — canvas positions live there and are excluded from
the content hash, so moving a node is not a semantic change. `params` are
available to nodes as `{{ params.x }}`; `{{ run.date }}`, `{{ run.id }}`,
`{{ run.logicalDate }}` and `{{ run.pipeline }}` are also substituted in string
configuration values.

## Node types

A node type is one registry entry:

```ts
{
  type: "postgres.source",
  kind: "source",
  label: "PostgreSQL source",
  description: "Reads rows from a PostgreSQL table or query.",
  inputs: { min: 0, max: 0 },
  outputs: ["default"],
  connectorFamily: "postgres",
  producesDataset: true,
  fields: [ /* FieldSchema[] */ ],
}
```

That one declaration is the source of truth for three consumers: the validator
enforces it, the editor renders a form from it, and the docs table below is read
from it. They cannot drift apart.

| Kind | Types |
| --- | --- |
| `source` | `postgres.source`, `mysql.source`, `csv.source`, `json.source`, `http.source`, `s3.source`, `inline.source`, `generator.source` |
| transform | `sql.transform`, `filter.transform`, `aggregate.transform`, `join.transform`, `python.transform` |
| validation | `schema.validate`, `quality.check`, `quality.gate` |
| `destination` | `postgres.destination`, `mysql.destination`, `s3.destination`, `dataset.destination` |
| control | `http.request`, `webhook.notify`, `delay.wait`, `condition.branch` |

`destructive: true` marks a type that mutates an external system. The retry
planner refuses to retry those unless the node's configuration sets
`idempotent: true` — re-running a non-idempotent `COPY` into a warehouse is how
revenue gets double counted.

`condition.branch` has two output ports, `true` and `false`. Only the selected
branch runs; the other is marked `SKIPPED`.

## Validation

`validateWorkflow(definition, context)` returns errors and warnings anchored to
node IDs and field names so the editor can highlight them in place.

| Code | Meaning |
| --- | --- |
| `workflow.name_invalid`, `workflow.empty`, `workflow.too_large` | Shape of the definition itself. |
| `node.id_invalid`, `node.id_duplicate` | Node IDs address task state and logs, so they must be unique and well-formed. |
| `node.type_unknown`, `node.type_unsupported` | Unknown type, or a connector family this deployment does not enable. |
| `node.config_invalid` | A field failed its schema, including unknown keys. |
| `node.missing_input`, `node.too_many_inputs`, `node.disconnected` | Arity and connectivity. |
| `node.timeout_invalid`, `node.retry_invalid` | Out-of-range timeout or an explicit backoff shorter than the retry count. |
| `node.destructive_retry` | *Warning.* A write node retries but is not marked idempotent. |
| `edge.node_missing`, `edge.port_unknown`, `edge.self_loop` | Edge references. |
| `graph.cycle` | Names the loop: `a -> b -> c -> a`. |
| `graph.no_source` | Nothing to read. |
| `graph.no_destination`, `graph.fragmented` | *Warnings.* |
| `dependency.unresolved`, `dependency.not_upstream` | A node references another node that is not connected to it. |
| `credential.connection_missing`, `credential.secret_missing` | The referenced connection or secret does not exist or is not visible to you. |
| `quality.gate_without_check` | A gate with nothing upstream to evaluate. |

The interesting one is `dependency.not_upstream`, because it catches the class of
mistake that otherwise fails at 02:14:

```text
Pipeline cannot run

Error [aggregate_sales]: Node "aggregate_sales" requires input from "clean_sales". The dependency is missing.
  Connect "clean_sales" to "aggregate_sales" with an edge, or point left at one of: customers.
```

SQL transforms are checked the same way: table names in `FROM` and `JOIN` must be
an upstream node ID, a declared alias, or `input` (the implicit alias when there
is exactly one upstream node). A typo is a validation error, not a 2 a.m. page.

## Versioning

Every save produces a version; every version is `draft`, `published` or
`deprecated`.

- Editing a published pipeline creates a **new draft**. Published versions are
  never mutated, so a run in flight keeps executing exactly what it started with.
- Publishing marks the draft `published` and the previous version `deprecated`,
  in one transaction. The database enforces at most one published version per
  pipeline with a partial unique index.
- `definitionHash` is a SHA-256 over the canonical form — nodes sorted, keys
  ordered, positions excluded. Two definitions that execute identically hash
  identically.

`diffWorkflows(before, after)` produces the change summary shown in the UI and
returned by `dataflow pipeline diff`:

```text
daily-sales v3
+ 2 nodes
- 1 node
~ 3 configurations changed
+ quality check (revenue_checks)
```

A canvas-only change reports `No semantic changes`.

## Retry policy

```ts
{
  maxAttempts: 3,
  strategy: "exponential",     // or "fixed" | "explicit"
  initialDelaySeconds: 5,
  multiplier: 6,               // 5s, 30s, 180s
  maxDelaySeconds: 900,
  retryableErrors: ["timeout", "connection", "rate_limit", "transient", "internal"],
  nonRetryableErrors: ["permission"],
}
```

`classifyError` maps a thrown value onto one of those classes from its message,
its `code`, or an explicit `errorClass` property. `validation`, `permission`,
`not_found`, `configuration`, `data_quality` and `cancelled` are never retried:
retrying a query against a column that does not exist just wastes a warehouse
slot.

`backoffSchedule(policy)` returns the whole schedule, which is what the editor
displays so an author can see "5s, 30s, 3m" before publishing.

## Templates

`PIPELINE_TEMPLATES` ships five examples, including one (`demo-daily-sales`) that
runs with no external systems at all. Templates are created as **drafts** and are
clearly labelled: a template is an example, not a deployment.

## Using it directly

```ts
import { parseWorkflow, validateWorkflow, definitionHash, diffWorkflows } from "@dataflow-studio/workflow-engine";

const definition = parseWorkflow(await readFile("pipeline.json", "utf8"));
const result = validateWorkflow(definition, { connections: { conn_1: "postgres" }, secrets: ["pg-password"] });

if (!result.valid) {
  for (const issue of result.errors) console.error(issue.nodeId, issue.message);
  process.exit(2);
}
console.log(definitionHash(definition));
```

`parseWorkflow` is a hostile-input boundary: it enforces a size cap, rejects
malformed shapes with a path (`nodes[3].config must be an object`), and drops
unknown top-level keys rather than trusting them.
