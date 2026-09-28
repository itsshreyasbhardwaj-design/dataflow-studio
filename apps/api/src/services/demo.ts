import { PIPELINE_TEMPLATES, definitionHash, type PipelineTemplate } from "@dataflow-studio/workflow-engine";
import { newId } from "@dataflow-studio/observability";
import { audited, authorize, type ApiContext } from "../context.js";
import { ApiError } from "../errors.js";

export interface SeedResult {
  pipelines: Array<{ id: string; name: string; runId?: string }>;
  /** Always true on seeded records, so the UI can label them. */
  isDemo: true;
}

/**
 * Seeds clearly-labelled demo pipelines.
 *
 * Every record created here carries `isDemo`, the dashboard shows a DEMO badge for
 * them, and analytics can be filtered to exclude them. Demo executions are real
 * executions - they use the generator source and the managed dataset destination,
 * so no external system is touched and no number is fabricated.
 */
export async function seedDemoData(
  context: ApiContext,
  options: { execute?: boolean; templateIds?: string[] } = {},
): Promise<SeedResult> {
  authorize(context, "pipeline.create");
  const organizationId = context.principal.organizationId;
  const templates = PIPELINE_TEMPLATES.filter(
    (template) => template.category === "demo" || (options.templateIds?.includes(template.id) ?? false),
  );
  if (!templates.length) throw ApiError.validation("No demo templates matched");

  return audited(context, { action: "demo.seed", resourceType: "organization", resourceId: organizationId }, async () => {
    const created: SeedResult["pipelines"] = [];

    for (const template of templates) {
      const existing = await context.store.getPipelineByName(organizationId, template.name);
      if (existing) {
        created.push({ id: existing.id, name: existing.name });
        continue;
      }
      const { pipelineId, runId } = await seedTemplate(context, template, options.execute ?? false);
      created.push({ id: pipelineId, name: template.name, ...(runId ? { runId } : {}) });
    }
    return { pipelines: created, isDemo: true };
  });
}

async function seedTemplate(
  context: ApiContext,
  template: PipelineTemplate,
  execute: boolean,
): Promise<{ pipelineId: string; runId?: string }> {
  const organizationId = context.principal.organizationId;
  const now = context.now.toISOString();
  const pipelineId = newId("pipe");
  const versionId = newId("ver");
  const definition = structuredClone(template.definition);

  await context.store.createPipeline({
    id: pipelineId,
    organizationId,
    name: template.name,
    description: `DEMO · ${template.description}`,
    publishedVersionId: versionId,
    latestVersionNumber: 1,
    createdBy: context.principal.userId,
    createdAt: now,
    updatedAt: now,
    tags: ["demo"],
    isDemo: true,
  });
  await context.store.createVersion({
    id: versionId,
    organizationId,
    pipelineId,
    version: 1,
    status: "published",
    definition,
    definitionHash: definitionHash(definition),
    createdBy: context.principal.userId,
    createdAt: now,
    publishedAt: now,
  });

  if (!execute) return { pipelineId };

  const run = await context.engine.startRun({
    organizationId,
    pipelineId,
    pipelineName: template.name,
    pipelineVersionId: versionId,
    version: 1,
    definition,
    trigger: "manual",
    triggeredBy: context.principal.userId,
    isDemo: true,
  });
  await context.engine.executeRunToCompletion(organizationId, run.id);
  return { pipelineId, runId: run.id };
}

export function listTemplates(): Array<Omit<PipelineTemplate, "definition"> & { nodeCount: number }> {
  return PIPELINE_TEMPLATES.map(({ definition, ...rest }) => ({ ...rest, nodeCount: definition.nodes.length }));
}

export async function createFromTemplate(
  context: ApiContext,
  input: { templateId: string; name?: string },
): Promise<{ pipelineId: string; name: string }> {
  authorize(context, "pipeline.create");
  const template = PIPELINE_TEMPLATES.find((t) => t.id === input.templateId);
  if (!template) throw ApiError.notFound("Template", input.templateId);

  const organizationId = context.principal.organizationId;
  const name = (input.name ?? template.name).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
  if (await context.store.getPipelineByName(organizationId, name)) {
    throw ApiError.conflict(`A pipeline named "${name}" already exists`);
  }

  const now = context.now.toISOString();
  const pipelineId = newId("pipe");
  const definition = structuredClone(template.definition);
  definition.name = name;

  return audited(
    context,
    { action: "pipeline.create", resourceType: "pipeline", resourceId: pipelineId, metadata: { templateId: template.id } },
    async () => {
      await context.store.createPipeline({
        id: pipelineId,
        organizationId,
        name,
        description: `Created from the "${template.title}" template. ${template.requires.length ? `Requires: ${template.requires.join("; ")}` : ""}`.trim(),
        publishedVersionId: null,
        latestVersionNumber: 1,
        createdBy: context.principal.userId,
        createdAt: now,
        updatedAt: now,
        tags: ["template"],
      });
      // Templates arrive as a draft: a template is an example, not a deployment.
      await context.store.createVersion({
        id: newId("ver"),
        organizationId,
        pipelineId,
        version: 1,
        status: "draft",
        definition,
        definitionHash: definitionHash(definition),
        createdBy: context.principal.userId,
        createdAt: now,
      });
      return { pipelineId, name };
    },
  );
}
