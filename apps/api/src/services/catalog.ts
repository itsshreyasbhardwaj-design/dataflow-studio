import type { Dataset, Incident, QualityResultRecord } from "@dataflow-studio/database";
import { buildLineage, mergeGraphs, traverse, type LineageGraph } from "@dataflow-studio/lineage";
import type { DataSchema, SchemaDiff } from "@dataflow-studio/schema-registry";
import { diffSchemas } from "@dataflow-studio/schema-registry";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

export async function listDatasets(
  context: ApiContext,
  filter: { search?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: Dataset[]; nextCursor?: string }> {
  authorize(context, "dataset.read");
  const page = await context.store.listDatasets(context.principal.organizationId, filter);
  return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export interface DatasetDetail {
  dataset: Dataset;
  schemas: DataSchema[];
  /** Diff between the two most recent schema versions, when there are two. */
  latestChange: SchemaDiff | null;
  quality: QualityResultRecord[];
  upstream: LineageGraph["nodes"];
  downstream: LineageGraph["nodes"];
  producedBy: Array<{ pipelineId: string; pipelineName: string; nodeId: string }>;
  preview: { rows: Array<Record<string, unknown>>; columns: unknown[]; rowCount: number } | null;
}

export async function getDataset(context: ApiContext, name: string): Promise<DatasetDetail> {
  authorize(context, "dataset.read");
  const organizationId = context.principal.organizationId;
  const dataset = await context.store.getDataset(organizationId, name);
  if (!dataset) throw ApiError.notFound("Dataset", name);

  const [schemas, quality, graph, preview] = await Promise.all([
    context.store.listSchemaVersions(organizationId, name),
    context.store.listQualityResults(organizationId, { dataset: name, limit: 50 }),
    organizationLineage(context),
    context.store.getDatasetRows(organizationId, name),
  ]);

  const { upstream, downstream } = traverse(graph, name, "dataset");
  const producedBy = graph.edges
    .filter((edge) => edge.toType === "dataset" && edge.to === name && edge.nodeId)
    .map((edge) => ({
      pipelineId: edge.pipelineId ?? "",
      pipelineName: graph.nodes.find((n) => n.id === edge.nodeId)?.pipelineName ?? "",
      nodeId: edge.nodeId!,
    }));

  const previous = schemas.at(-2);
  const latest = schemas.at(-1);
  return {
    dataset,
    schemas,
    latestChange: previous && latest ? diffSchemas(previous.columns, latest.columns) : null,
    quality,
    upstream,
    downstream,
    producedBy,
    preview: preview ? { ...preview, rows: preview.rows.slice(0, 100) } : null,
  };
}

/** Builds the organization-wide lineage graph from published versions. */
export async function organizationLineage(context: ApiContext, pipelineId?: string): Promise<LineageGraph> {
  authorize(context, "dataset.read");
  const organizationId = context.principal.organizationId;
  const pipelines = await context.store.listPipelines(organizationId, { limit: 200 });
  const graphs: LineageGraph[] = [];

  for (const pipeline of pipelines.items) {
    if (pipelineId && pipeline.id !== pipelineId) continue;
    const versionId = pipeline.publishedVersionId;
    if (!versionId) continue;
    const version = await context.store.getVersion(organizationId, versionId);
    if (!version) continue;
    graphs.push(buildLineage(version.definition, {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      pipelineVersionId: version.id,
    }));
  }
  return mergeGraphs(graphs);
}

export async function listIncidents(
  context: ApiContext,
  filter: { status?: Incident["status"]; kind?: Incident["kind"]; limit?: number; cursor?: string } = {},
): Promise<{ items: Incident[]; nextCursor?: string }> {
  authorize(context, "incident.read");
  const page = await context.store.listIncidents(context.principal.organizationId, filter);
  return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export async function updateIncident(
  context: ApiContext,
  incidentId: string,
  input: { status: Incident["status"] },
): Promise<Incident> {
  authorize(context, "incident.edit");
  const incidents = await context.store.listIncidents(context.principal.organizationId, { limit: 200 });
  const incident = incidents.items.find((i) => i.id === incidentId);
  if (!incident) throw ApiError.notFound("Incident", incidentId);

  return audited(
    context,
    { action: `incident.${input.status}`, resourceType: "incident", resourceId: incidentId },
    async () => context.store.updateIncident(context.principal.organizationId, incidentId, {
      status: input.status,
      ...(input.status === "acknowledged" ? { acknowledgedBy: context.principal.userId } : {}),
      ...(input.status === "resolved" ? { resolvedAt: context.now.toISOString() } : {}),
    }),
  );
}

export async function search(context: ApiContext, query: string, limit = 20): Promise<Awaited<ReturnType<ApiContext["store"]["search"]>>> {
  authorize(context, "pipeline.read");
  if (query.trim().length > 200) throw ApiError.validation("Search query is too long");
  return context.store.search(context.principal.organizationId, query, limit);
}
