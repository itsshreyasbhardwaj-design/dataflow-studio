import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { LineageGraphView } from "@/components/lineage-graph";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lineage" };

export default async function LineagePage({ searchParams }: { searchParams: Promise<{ pipelineId?: string }> }) {
  const query = await searchParams;
  const context = await getServerContext();

  const [graph, pipelines] = await Promise.all([
    services.catalog.organizationLineage(context, query.pipelineId),
    services.pipelines.listPipelines(context, { limit: 100 }),
  ]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">Lineage</h1>
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          Datasets and the pipeline nodes that move data between them, derived from published definitions.
        </p>
      </div>
      <LineageGraphView
        graph={graph as never}
        pipelines={pipelines.items.map((pipeline) => ({ id: pipeline.id, name: pipeline.name }))}
        {...(query.pipelineId ? { selectedPipelineId: query.pipelineId } : {})}
      />
    </div>
  );
}
