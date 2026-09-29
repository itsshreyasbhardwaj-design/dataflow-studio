import Link from "next/link";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Button, Card, EmptyState, StateBadge, Table, Td, Th } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Runs" };

const STATES = ["", "RUNNING", "QUEUED", "SUCCESS", "FAILED", "CANCELLED"] as const;

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ state?: string; cursor?: string; trigger?: string }> }) {
  const query = await searchParams;
  const context = await getServerContext();
  const page = await services.runs.listRuns(context, {
    limit: 50,
    ...(query.state ? { state: query.state } : {}),
    ...(query.trigger ? { trigger: query.trigger } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Runs</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">Every execution, newest first.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATES.map((state) => (
            <Link key={state || "all"} href={`/runs${state ? `?state=${state}` : ""}`}>
              <Button size="sm" variant={query.state === state || (!query.state && !state) ? "primary" : "secondary"}>
                {state || "All"}
              </Button>
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {page.items.length === 0
          ? <EmptyState title="No runs match this filter" description="Trigger a pipeline, or clear the filter." action={<Link href="/runs"><Button size="sm">Clear</Button></Link>} />
          : (
            <Table>
              <thead>
                <tr>
                  <Th>Run</Th><Th>Pipeline</Th><Th>State</Th><Th>Trigger</Th>
                  <Th align="right">Tasks</Th><Th align="right">Duration</Th><Th align="right">Started</Th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((run) => (
                  <tr key={run.id} className="hover:bg-[var(--color-surface-raised)]">
                    <Td><Link href={`/runs/${run.id}`} className="mono hover:text-[var(--color-accent)]">{run.id}</Link></Td>
                    <Td>
                      <Link href={`/pipelines/${run.pipelineId}`} className="font-medium hover:text-[var(--color-accent)]">{run.pipelineName}</Link>
                      <span className="ml-1.5 mono text-[var(--color-text-subtle)]">v{run.version}</span>
                      {run.isDemo && <Badge className="ml-2" tone="warning">DEMO</Badge>}
                    </Td>
                    <Td><StateBadge state={run.state} /></Td>
                    <Td><span className="mono text-[var(--color-text-muted)]">{run.trigger}</span></Td>
                    <Td align="right"><span className="mono">{run.totals ? `${run.totals.succeeded}/${run.totals.tasks}` : "–"}</span></Td>
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
          <Link href={`/runs?cursor=${page.nextCursor}${query.state ? `&state=${query.state}` : ""}`}><Button size="sm">Load more</Button></Link>
        </div>
      )}
    </div>
  );
}
