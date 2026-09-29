import Link from "next/link";
import { notFound } from "next/navigation";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Button, Card, EmptyState, StateBadge, Table, Td, Th } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PipelineRunsPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string; state?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const context = await getServerContext();

  const pipeline = await context.store.getPipeline(context.principal.organizationId, id);
  if (!pipeline) notFound();

  const page = await services.runs.listRuns(context, {
    pipelineId: id,
    limit: 50,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.state ? { state: query.state } : {}),
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">
            <Link href={`/pipelines/${id}`} className="hover:text-[var(--color-accent)]">{pipeline.name}</Link>
            <span className="text-[var(--color-text-subtle)]"> / runs</span>
          </h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">Full execution history for this pipeline.</p>
        </div>
        <div className="flex items-center gap-1.5">
          {["", "SUCCESS", "FAILED", "RUNNING"].map((state) => (
            <Link key={state || "all"} href={`/pipelines/${id}/runs${state ? `?state=${state}` : ""}`}>
              <Button size="sm" variant={query.state === state || (!query.state && !state) ? "primary" : "secondary"}>
                {state || "All"}
              </Button>
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {page.items.length === 0
          ? <EmptyState title="No runs match" description="Trigger a run, or clear the filter." />
          : (
            <Table>
              <thead>
                <tr>
                  <Th>Run</Th><Th>Version</Th><Th>State</Th><Th>Trigger</Th>
                  <Th>Logical date</Th><Th align="right">Tasks</Th><Th align="right">Duration</Th><Th align="right">Started</Th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((run) => (
                  <tr key={run.id} className="hover:bg-[var(--color-surface-raised)]">
                    <Td><Link href={`/runs/${run.id}`} className="mono hover:text-[var(--color-accent)]">{run.id}</Link></Td>
                    <Td><span className="mono">v{run.version}</span></Td>
                    <Td><StateBadge state={run.state} /></Td>
                    <Td><span className="mono text-[var(--color-text-muted)]">{run.trigger}</span></Td>
                    <Td><span className="mono text-[11.5px] text-[var(--color-text-muted)]">{run.logicalDate?.slice(0, 16).replace("T", " ") ?? "–"}</span></Td>
                    <Td align="right">
                      <span className="mono">
                        {run.totals ? `${run.totals.succeeded}/${run.totals.tasks}` : "–"}
                      </span>
                    </Td>
                    <Td align="right"><span className="mono">{formatDuration(run.durationMs)}</span></Td>
                    <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatDateTime(run.queuedAt)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </Card>

      {page.nextCursor && (
        <div className="flex justify-center">
          <Link href={`/pipelines/${id}/runs?cursor=${page.nextCursor}${query.state ? `&state=${query.state}` : ""}`}>
            <Button size="sm">Load more</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
