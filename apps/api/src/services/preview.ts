import { ConnectorRegistry } from "@dataflow-studio/connectors";
import { profileRows, makeBatch, type ColumnProfile, type DataBatch } from "@dataflow-studio/schema-registry";
import { parseSelect, runQuery } from "@dataflow-studio/transformations";
import { parseChecks, runChecks, type QualityResult } from "@dataflow-studio/data-quality";
import { getNodeType, applyDefaults, type NodeConfig } from "@dataflow-studio/workflow-engine";
import { resolveSecrets } from "@dataflow-studio/secrets";
import { ApiError } from "../errors.js";
import { authorize, type ApiContext } from "../context.js";

export const PREVIEW_ROW_LIMIT = 100;

export interface PreviewResult {
  rows: Array<Record<string, unknown>>;
  profile: ColumnProfile[];
  rowCount: number;
  truncated: boolean;
  /** Milliseconds the preview took, so a slow source is visible. */
  durationMs: number;
}

/**
 * Reads a bounded sample from a source node so the editor can show real data.
 *
 * The limit is enforced here rather than trusted from the client, and the result
 * is profiled server-side. Secret values are resolved for the read and never
 * returned.
 */
export async function previewSource(
  context: ApiContext,
  input: { nodeType: string; config: Record<string, unknown>; limit?: number },
): Promise<PreviewResult> {
  authorize(context, "pipeline.read");
  const definition = getNodeType(input.nodeType);
  if (!definition) throw ApiError.validation(`Unknown node type "${input.nodeType}"`);
  if (definition.kind !== "source") throw ApiError.validation("Only source nodes can be previewed directly");

  const organizationId = context.principal.organizationId;
  const limit = Math.min(input.limit ?? PREVIEW_ROW_LIMIT, PREVIEW_ROW_LIMIT);
  let config = applyDefaults(definition.fields, input.config as NodeConfig);

  const connectionId = config["connectionId"];
  if (typeof connectionId === "string" && connectionId) {
    const connection = await context.store.getConnection(organizationId, connectionId);
    if (!connection) throw ApiError.notFound("Connection", connectionId);
    config = {
      ...(connection.config as NodeConfig),
      ...Object.fromEntries(Object.entries(connection.secretRefs).map(([key, secret]) => [key, { secretRef: String(secret) }] as const)),
      ...config,
    };
  }
  const resolved = await resolveSecrets(config, { organizationId, provider: context.secrets });

  const registry = new ConnectorRegistry({
    organizationId,
    fileStore: {
      readFile: async (org, fileId) => {
        const stored = await context.store.getFile(org, fileId);
        if (!stored) throw ApiError.notFound("Uploaded file", fileId);
        return { content: stored.content, filename: stored.file.filename };
      },
      writeFile: async () => { throw ApiError.validation("Preview cannot write files"); },
    },
    datasetStore: {
      putDataset: async () => { throw ApiError.validation("Preview cannot write datasets"); },
      getDataset: (org, dataset) => context.store.getDatasetRows(org, dataset) as never,
    },
  });

  const startedAt = Date.now();
  try {
    const batch = await registry.forNodeType(input.nodeType).read({ config: resolved.value, limit });
    return toPreview(batch, Date.now() - startedAt);
  } finally {
    await registry.close();
  }
}

/** Runs a SQL transform against sample data the caller supplies. */
export async function previewSql(
  context: ApiContext,
  input: { query: string; inputs: Record<string, Array<Record<string, unknown>>> },
): Promise<PreviewResult> {
  authorize(context, "pipeline.read");
  // Parse first so a syntax error is a clean 422 rather than an execution failure.
  try {
    parseSelect(input.query);
  } catch (error) {
    throw ApiError.validation((error as Error).message);
  }
  const batches = Object.fromEntries(
    Object.entries(input.inputs).map(([name, rows]) => [name, makeBatch(rows.slice(0, 1000), [])]),
  );
  const startedAt = Date.now();
  try {
    const batch = runQuery(input.query, batches as never, { now: context.now, maxOutputRows: PREVIEW_ROW_LIMIT });
    return toPreview(batch, Date.now() - startedAt);
  } catch (error) {
    throw ApiError.validation((error as Error).message);
  }
}

export interface QualityPreviewResult {
  results: QualityResult[];
  passed: number;
  failed: number;
}

/** Evaluates quality checks against sample rows, so a check can be tuned before publishing. */
export async function previewQuality(
  context: ApiContext,
  input: { checks: unknown; rows: Array<Record<string, unknown>> },
): Promise<QualityPreviewResult> {
  authorize(context, "pipeline.read");
  let checks;
  try {
    checks = parseChecks(input.checks);
  } catch (error) {
    throw ApiError.validation((error as Error).message);
  }
  const batch = makeBatch(input.rows.slice(0, 5000), []);
  const results = runChecks(batch, checks, { now: context.now });
  return {
    results,
    passed: results.filter((r) => r.status === "PASSED").length,
    failed: results.filter((r) => r.status !== "PASSED").length,
  };
}

function toPreview(batch: DataBatch, durationMs: number): PreviewResult {
  const rows = batch.rows.slice(0, PREVIEW_ROW_LIMIT);
  return {
    rows,
    profile: profileRows(rows),
    rowCount: batch.rowCount,
    truncated: batch.truncated ?? batch.rowCount > rows.length,
    durationMs,
  };
}
