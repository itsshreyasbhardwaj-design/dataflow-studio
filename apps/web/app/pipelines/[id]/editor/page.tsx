import { notFound } from "next/navigation";
import { services, hasPermission } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { PipelineEditor } from "@/components/editor/pipeline-editor";

export const dynamic = "force-dynamic";

export default async function PipelineEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getServerContext();

  const detail = await services.pipelines.getPipeline(context, id).catch(() => null);
  if (!detail || !detail.currentVersion) notFound();

  const [connections, secrets] = await Promise.all([
    services.connections.listConnections(context),
    services.secrets.listSecrets(context),
  ]);

  return (
    <PipelineEditor
      pipelineId={id}
      pipelineName={detail.pipeline.name}
      definition={detail.currentVersion.definition}
      versionStatus={detail.currentVersion.status}
      versionNumber={detail.currentVersion.version}
      secrets={secrets.map((secret) => secret.name)}
      connections={connections.map((connection) => ({ id: connection.id, name: connection.name, family: connection.family }))}
      canEdit={hasPermission(context.principal.role, "pipeline.edit")}
      canPublish={hasPermission(context.principal.role, "workflow.publish")}
      canRun={hasPermission(context.principal.role, "pipeline.execute")}
    />
  );
}
