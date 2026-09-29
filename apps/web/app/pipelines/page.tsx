import Link from "next/link";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Button, Card, EmptyState, StateBadge, Table, Td, Th } from "@/components/ui";
import { SeedDemoButton } from "@/components/actions";
import { formatDuration, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipelines" };

export default async function PipelinesPage({ searchParams }: { searchParams: Promise<{ search?: string; cursor?: string }> }) {
  const params = await searchParams;
  const context = await getServerContext();
  const page = await services.pipelines.listPipelines(context, {
    ...(params.search ? { search: params.search } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    limit: 50,
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Pipelines</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            {page.total ?? page.items.length} pipeline{(page.total ?? page.items.length) === 1 ? "" : "s"} · published versions are immutable
          </p>
        </div>
        <form className="flex items-center gap-2" action="/pipelines">
          <input
            name="search"
            defaultValue={params.search ?? ""}
            placeholder="Filter by name…"
            aria-label="Filter pipelines"
            className="h-8 w-56 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <Button type="submit" size="sm">Filter</Button>
          <Link href="/pipelines/new"><Button variant="primary" size="sm">New pipeline</Button></Link>
        </form>
      </div>

      <Card>
        {page.items.length === 0 ? (
          <EmptyState
            title={params.search ? `No pipeline matches “${params.search}”` : "No pipelines yet"}
            description={params.search ? undefined : "Create one from scratch, start from a template, or seed the demo pipeline to see the full lifecycle."}
            action={params.search ? <Link href="/pipelines"><Button size="sm">Clear filter</Button></Link> : <SeedDemoButton />}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pipeline</Th><Th>Published</Th><Th>Last run</Th><Th align="right">Duration</Th>
                <Th align="right">When</Th><Th align="right">Schedules</Th><Th />
              </tr>
            </thead>
            <tbody>
              {page.items.map((pipeline) => (
                <tr key={pipeline.id} className="hover:bg-[var(--color-surface-raised)]">
                  <Td>
                    <Link href={`/pipelines/${pipeline.id}`} className="font-medium hover:text-[var(--color-accent)]">{pipeline.name}</Link>
                    {pipeline.isDemo && <Badge className="ml-2" tone="warning">DEMO</Badge>}
                    {pipeline.description && (
                      <div className="mt-0.5 max-w-lg truncate text-[11.5px] text-[var(--color-text-subtle)]">{pipeline.description}</div>
                    )}
                  </Td>
                  <Td>
                    {pipeline.publishedVersion
                      ? <Badge tone="success" mono>v{pipeline.publishedVersion}</Badge>
                      : <Badge tone="neutral">draft only</Badge>}
                  </Td>
                  <Td>{pipeline.latestRun ? <StateBadge state={pipeline.latestRun.state} /> : <span className="text-[var(--color-text-subtle)]">never run</span>}</Td>
                  <Td align="right"><span className="mono">{formatDuration(pipeline.latestRun?.durationMs)}</span></Td>
                  <Td align="right"><span className="text-[var(--color-text-muted)]">{formatRelative(pipeline.latestRun?.queuedAt)}</span></Td>
                  <Td align="right"><span className="mono">{pipeline.scheduleCount}</span></Td>
                  <Td align="right">
                    <Link href={`/pipelines/${pipeline.id}/editor`} className="text-[12px] text-[var(--color-accent)]">Edit</Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {page.nextCursor && (
        <div className="flex justify-center">
          <Link href={`/pipelines?cursor=${page.nextCursor}${params.search ? `&search=${encodeURIComponent(params.search)}` : ""}`}>
            <Button size="sm">Load more</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
