import type { Pipeline, PipelineVersion, WorkflowRun } from "@dataflow-studio/database";
import { newId } from "@dataflow-studio/observability";
import { maskConfig } from "@dataflow-studio/secrets";
import {
  definitionHash, diffWorkflows, formatValidationResult, parseWorkflow, validateWorkflow,
  type ValidationResult, type WorkflowDefinition, type WorkflowDiff,
} from "@dataflow-studio/workflow-engine";
import { buildLineage } from "@dataflow-studio/lineage";
import { ApiError } from "../errors.js";
import { audit, audited, authorize, type ApiContext } from "../context.js";

export interface PipelineSummary extends Pipeline {
  latestRun?: WorkflowRun | undefined;
  scheduleCount: number;
  publishedVersion?: number | undefined;
}

export async function listPipelines(
  context: ApiContext,
  filter: { limit?: number; cursor?: string; search?: string; tag?: string; includeArchived?: boolean } = {},
): Promise<{ items: PipelineSummary[]; nextCursor?: string; total?: number }> {
  authorize(context, "pipeline.read");
  const page = await context.store.listPipelines(context.principal.organizationId, filter);
  // One batched query for the latest runs instead of one per pipeline.
  const latest = await context.store.latestRunPerPipeline(
    context.principal.organizationId,
    page.items.map((p) => p.id),
  );
  const schedules = await context.store.listSchedules(context.principal.organizationId);

  const items: PipelineSummary[] = [];
  for (const pipeline of page.items) {
    const published = pipeline.publishedVersionId
      ? await context.store.getVersion(context.principal.organizationId, pipeline.publishedVersionId)
      : null;
    items.push({
      ...pipeline,
      latestRun: latest[pipeline.id],
      scheduleCount: schedules.filter((s) => s.pipelineId === pipeline.id).length,
      publishedVersion: published?.version,
    });
  }
  return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.total !== undefined ? { total: page.total } : {}) };
}

export interface PipelineDetail {
  pipeline: Pipeline;
  versions: Array<Omit<PipelineVersion, "definition">>;
  /** The version the editor should open: the draft if there is one, else published. */
  currentVersion: PipelineVersion | null;
  recentRuns: WorkflowRun[];
  schedules: Awaited<ReturnType<ApiContext["store"]["listSchedules"]>>;
  validation: ValidationResult | null;
}

export async function getPipeline(context: ApiContext, pipelineId: string): Promise<PipelineDetail> {
  authorize(context, "pipeline.read");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", pipelineId);

  const versions = await context.store.listVersions(organizationId, pipelineId);
  const draft = versions.find((v) => v.status === "draft");
  const published = versions.find((v) => v.status === "published");
  const currentVersion = draft ?? published ?? versions[0] ?? null;
  const runs = await context.store.listRuns(organizationId, { pipelineId, limit: 10 });

  return {
    pipeline,
    versions: versions.map(({ definition: _definition, ...rest }) => rest),
    currentVersion: currentVersion ? withMaskedConfig(currentVersion) : null,
    recentRuns: runs.items,
    schedules: await context.store.listSchedules(organizationId, pipelineId),
    validation: currentVersion ? await validate(context, currentVersion.definition) : null,
  };
}

/** Secret references are returned as masked markers, never as values. */
function withMaskedConfig(version: PipelineVersion): PipelineVersion {
  return {
    ...version,
    definition: {
      ...version.definition,
      nodes: version.definition.nodes.map((node) => ({ ...node, config: maskConfig(node.config ?? {}) })),
    },
  };
}

export async function validate(context: ApiContext, definition: WorkflowDefinition): Promise<ValidationResult> {
  const organizationId = context.principal.organizationId;
  const connections = await context.store.listConnections(organizationId);
  const secrets = await context.secrets.list(organizationId);
  return validateWorkflow(definition, {
    connections: Object.fromEntries(connections.map((c) => [c.id, c.family])),
    secrets: secrets.map((s) => s.name),
  });
}

export interface CreatePipelineInput {
  name: string;
  description?: string;
  definition?: WorkflowDefinition | unknown;
  tags?: string[];
  isDemo?: boolean;
}

export async function createPipeline(context: ApiContext, input: CreatePipelineInput): Promise<PipelineDetail> {
  authorize(context, "pipeline.create");
  const organizationId = context.principal.organizationId;
  const now = context.now.toISOString();

  const definition = input.definition
    ? parseWorkflow(input.definition)
    : { name: input.name, version: 1, nodes: [], edges: [] };
  definition.name = input.name;
  definition.version = 1;

  if (await context.store.getPipelineByName(organizationId, input.name)) {
    throw ApiError.conflict(`A pipeline named "${input.name}" already exists`);
  }

  return audited(context, { action: "pipeline.create", resourceType: "pipeline", metadata: { name: input.name } }, async () => {
    const pipelineId = newId("pipe");
    const versionId = newId("ver");
    await context.store.createPipeline({
      id: pipelineId,
      organizationId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      publishedVersionId: null,
      latestVersionNumber: 1,
      createdBy: context.principal.userId,
      createdAt: now,
      updatedAt: now,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.isDemo ? { isDemo: true } : {}),
    });
    await context.store.createVersion({
      id: versionId,
      organizationId,
      pipelineId,
      version: 1,
      status: "draft",
      definition,
      definitionHash: definitionHash(definition),
      createdBy: context.principal.userId,
      createdAt: now,
    });
    return getPipeline(context, pipelineId);
  });
}

export interface UpdatePipelineInput {
  description?: string;
  tags?: string[];
  /** Saves a new draft version. Published versions are never mutated. */
  definition?: WorkflowDefinition | unknown;
  archived?: boolean;
}

export async function updatePipeline(context: ApiContext, pipelineId: string, input: UpdatePipelineInput): Promise<PipelineDetail> {
  authorize(context, "pipeline.edit");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", pipelineId);
  const now = context.now.toISOString();

  return audited(context, { action: "pipeline.edit", resourceType: "pipeline", resourceId: pipelineId }, async () => {
    if (input.definition) {
      const definition = parseWorkflow(input.definition);
      definition.name = pipeline.name;
      const versions = await context.store.listVersions(organizationId, pipelineId);
      const draft = versions.find((v) => v.status === "draft");

      if (draft) {
        // Editing an existing draft in place; the published version is untouched.
        definition.version = draft.version;
        await context.store.updateVersion(organizationId, draft.id, {
          definition,
          definitionHash: definitionHash(definition),
        });
      } else {
        const nextVersion = (versions[0]?.version ?? 0) + 1;
        definition.version = nextVersion;
        await context.store.createVersion({
          id: newId("ver"),
          organizationId,
          pipelineId,
          version: nextVersion,
          status: "draft",
          definition,
          definitionHash: definitionHash(definition),
          createdBy: context.principal.userId,
          createdAt: now,
        });
        await context.store.updatePipeline(organizationId, pipelineId, { latestVersionNumber: nextVersion });
      }
    }

    await context.store.updatePipeline(organizationId, pipelineId, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? now : null } : {}),
      updatedAt: now,
    });
    return getPipeline(context, pipelineId);
  });
}

export async function deletePipeline(context: ApiContext, pipelineId: string): Promise<{ deleted: boolean }> {
  authorize(context, "pipeline.delete");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", pipelineId);

  const running = await context.store.listRuns(organizationId, { pipelineId, state: ["RUNNING", "QUEUED"], limit: 1 });
  if (running.items.length) {
    throw ApiError.conflict("This pipeline has runs in flight. Cancel them before deleting it.");
  }
  return audited(context, { action: "pipeline.delete", resourceType: "pipeline", resourceId: pipelineId }, async () => ({
    deleted: await context.store.deletePipeline(organizationId, pipelineId),
  }));
}

export interface PublishResult {
  version: PipelineVersion;
  diff: WorkflowDiff | null;
  validation: ValidationResult;
}

/**
 * Publishes a draft. A publish is refused unless the definition validates, and it
 * never mutates the previously published version - it deprecates it, so a run in
 * flight keeps executing exactly what it started with.
 */
export async function publishPipeline(
  context: ApiContext,
  pipelineId: string,
  options: { versionId?: string } = {},
): Promise<PublishResult> {
  authorize(context, "workflow.publish");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", pipelineId);

  const versions = await context.store.listVersions(organizationId, pipelineId);
  const target = options.versionId
    ? versions.find((v) => v.id === options.versionId)
    : versions.find((v) => v.status === "draft");
  if (!target) throw ApiError.validation("There is no draft version to publish");
  if (target.status === "published") throw ApiError.conflict("That version is already published");

  const validation = await validate(context, target.definition);
  if (!validation.valid) {
    throw ApiError.validation(formatValidationResult(validation, pipeline.name), { issues: validation.errors });
  }

  const previous = versions.find((v) => v.status === "published");
  const diff = previous ? diffWorkflows(previous.definition, target.definition) : null;

  return audited(
    context,
    { action: "pipeline.publish", resourceType: "pipeline_version", resourceId: target.id, metadata: { version: target.version } },
    async () => {
      const published = await context.store.publishVersion(organizationId, pipelineId, target.id, context.now.toISOString());
      if (diff) await context.store.updateVersion(organizationId, target.id, { changeSummary: diff.summary });

      // Lineage is recorded per published version so the explorer reflects
      // production, not somebody's in-progress draft.
      const graph = buildLineage(target.definition, {
        pipelineId,
        pipelineName: pipeline.name,
        pipelineVersionId: target.id,
      });
      await context.store.replaceLineage(
        organizationId,
        target.id,
        graph.edges.map((edge) => ({
          id: newId("lin"),
          organizationId,
          pipelineId,
          pipelineVersionId: target.id,
          fromType: edge.fromType,
          fromId: edge.from,
          toType: edge.toType,
          toId: edge.to,
          ...(edge.nodeId ? { nodeId: edge.nodeId } : {}),
          ...(edge.transformation ? { transformation: edge.transformation } : {}),
          observedAt: context.now.toISOString(),
        })),
      );
      return { version: published, diff, validation };
    },
  );
}

export async function comparePipelineVersions(
  context: ApiContext,
  pipelineId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{ diff: WorkflowDiff; from: number; to: number }> {
  authorize(context, "pipeline.read");
  const organizationId = context.principal.organizationId;
  const [before, after] = await Promise.all([
    context.store.getVersionByNumber(organizationId, pipelineId, fromVersion),
    context.store.getVersionByNumber(organizationId, pipelineId, toVersion),
  ]);
  if (!before) throw ApiError.notFound(`Version ${fromVersion}`);
  if (!after) throw ApiError.notFound(`Version ${toVersion}`);
  return { diff: diffWorkflows(before.definition, after.definition), from: fromVersion, to: toVersion };
}

export interface RunPipelineInput {
  params?: Record<string, unknown>;
  versionId?: string;
  logicalDate?: string;
  /** Run the draft instead of the published version. Explicit, never implicit. */
  useDraft?: boolean;
}

export async function runPipeline(context: ApiContext, pipelineId: string, input: RunPipelineInput = {}): Promise<WorkflowRun> {
  authorize(context, "pipeline.execute");
  const organizationId = context.principal.organizationId;
  const pipeline = await context.store.getPipeline(organizationId, pipelineId);
  if (!pipeline) throw ApiError.notFound("Pipeline", pipelineId);

  const versions = await context.store.listVersions(organizationId, pipelineId);
  const version = input.versionId
    ? versions.find((v) => v.id === input.versionId)
    : input.useDraft
      ? versions.find((v) => v.status === "draft")
      : versions.find((v) => v.status === "published");

  if (!version) {
    throw ApiError.validation(
      input.useDraft
        ? "This pipeline has no draft version"
        : "This pipeline has no published version. Publish it first, or run the draft explicitly.",
    );
  }

  const validation = await validate(context, version.definition);
  if (!validation.valid) {
    throw ApiError.validation(formatValidationResult(validation, pipeline.name), { issues: validation.errors });
  }

  return audited(
    context,
    { action: "pipeline.run", resourceType: "pipeline", resourceId: pipelineId, metadata: { version: version.version } },
    async () =>
      context.engine.startRun({
        organizationId,
        pipelineId,
        pipelineName: pipeline.name,
        pipelineVersionId: version.id,
        version: version.version,
        definition: version.definition,
        trigger: context.principal.actorType === "api_key" ? "api" : "manual",
        triggeredBy: context.principal.apiKeyId ?? context.principal.userId,
        ...(input.params ? { params: input.params } : {}),
        ...(input.logicalDate ? { logicalDate: input.logicalDate } : {}),
        ...(pipeline.isDemo ? { isDemo: true } : {}),
        requestId: context.requestId,
      }),
  );
}

export async function validatePipelineDefinition(
  context: ApiContext,
  input: { pipelineId?: string; definition?: unknown },
): Promise<ValidationResult> {
  authorize(context, "pipeline.read");
  if (input.definition) {
    return validate(context, parseWorkflow(input.definition));
  }
  if (!input.pipelineId) throw ApiError.validation("Provide either a pipelineId or a definition");
  const versions = await context.store.listVersions(context.principal.organizationId, input.pipelineId);
  const version = versions.find((v) => v.status === "draft") ?? versions.find((v) => v.status === "published");
  if (!version) throw ApiError.notFound("Pipeline version");
  return validate(context, version.definition);
}

export { audit };
