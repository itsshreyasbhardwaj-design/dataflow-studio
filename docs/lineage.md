# Lineage

Lineage answers two questions: *where did this dataset come from*, and *what
breaks if I change it*.

## How it is derived

Lineage is computed from **published** pipeline definitions, not from a separate
catalog someone has to maintain. When a version is published, the graph is
rebuilt and stored as edges.

A node contributes to the graph when it names a dataset:

- A **source** that names one produces `dataset → node`.
- A **destination** that names one produces `node → dataset`.
- A **transform** that names one and declares `producesDataset` publishes an
  intermediate dataset.
- Everything else contributes `node → node` edges following the DAG.

`datasetOf` looks at `dataset`, then `table`, then `key`, so a PostgreSQL
destination writing to `reporting.orders` is catalogued as `reporting.orders`
without extra configuration.

## What is not claimed

A node that names nothing is reported, not guessed:

```json
{
  "unresolved": [
    { "nodeId": "fetch_partner_api", "nodeType": "http.source",
      "reason": "Source does not name a dataset, so its upstream origin is unknown" }
  ]
}
```

The lineage page lists these under the graph. A lineage diagram that quietly
invents an edge is worse than one that admits a gap — the whole point is to be
able to trust it during an incident.

## Traversal

```ts
import { buildLineage, traverse, mergeGraphs } from "@dataflow-studio/lineage";

const graph = buildLineage(definition, { pipelineId, pipelineName, pipelineVersionId });
const { upstream, downstream } = traverse(graph, "customer_revenue", "dataset");
```

`traverse` walks transitively in both directions and terminates on cycles.
`mergeGraphs` combines per-pipeline graphs into the organization-wide view, so a
dataset written by one pipeline and read by another connects them.

## Column lineage

For SQL transforms the column mapping is derived from the parsed select list:

```ts
columnLineage([
  { name: "customer_id", sources: ["customer_id"], expression: "customer_id", isStar: false },
  { name: "revenue", sources: ["amount"], expression: "sum(amount)", isStar: false },
]);
```

`SELECT *` is reported as `resolved: false` rather than being expanded from a
guess about the input schema. `unusedColumns` answers "which input columns does
nothing downstream depend on", and deliberately returns nothing when any mapping
is unresolved.

## In the product

- **`/lineage`** — the whole graph, filterable by pipeline, with datasets
  highlighted and unresolved nodes listed.
- **Dataset page** — upstream and downstream for that dataset, plus which
  pipeline and node produced it.
- **`GET /api/v1/lineage`** — the same graph as JSON.
- **`dataflow lineage`** — a text rendering for a terminal.

## Limits

Lineage is definition-level, not value-level. It records that a transform reads
`orders` and writes `orders_enriched`; it does not trace an individual row. It
reflects the published version, so a draft's changes appear only after publish.
Nodes whose target is computed at runtime (a templated object key, for example)
are catalogued under the template string.
