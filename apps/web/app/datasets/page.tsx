import Link from "next/link";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Button, Card, EmptyState, Table, Td, Th } from "@/components/ui";
import { formatNumber, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Datasets" };

export default async function DatasetsPage({ searchParams }: { searchParams: Promise<{ search?: string; cursor?: string }> }) {
  const query = await searchParams;
  const context = await getServerContext();
  const page = await services.catalog.listDatasets(context, {
    limit: 50,
    ...(query.search ? { search: query.search } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Datasets</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Catalogued by the pipelines that produce them. Schema history and quality results are recorded per run.
          </p>
        </div>
        <form action="/datasets" className="flex items-center gap-2">
          <input
            name="search"
            defaultValue={query.search ?? ""}
            placeholder="Filter datasets…"
            aria-label="Filter datasets"
            className="h-8 w-56 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <Button type="submit" size="sm">Filter</Button>
        </form>
      </div>

      <Card>
        {page.items.length === 0
          ? <EmptyState title="No datasets yet" description="A dataset appears here once a pipeline node that names one has run." />
          : (
            <Table>
              <thead>
                <tr>
                  <Th>Dataset</Th><Th>Produced by</Th><Th align="right">Rows</Th>
                  <Th align="right">Schema</Th><Th>Quality</Th><Th align="right">Updated</Th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((dataset) => (
                  <tr key={dataset.id} className="hover:bg-[var(--color-surface-raised)]">
                    <Td>
                      <Link href={`/datasets/${encodeURIComponent(dataset.name)}`} className="mono font-medium hover:text-[var(--color-accent)]">
                        {dataset.name}
                      </Link>
                      {dataset.isDemo && <Badge className="ml-2" tone="warning">DEMO</Badge>}
                    </Td>
                    <Td><span className="mono text-[11.5px] text-[var(--color-text-muted)]">{dataset.sourceType ?? "–"}</span></Td>
                    <Td align="right"><span className="mono">{formatNumber(dataset.rowCount)}</span></Td>
                    <Td align="right"><span className="mono">{dataset.latestSchemaVersion ? `v${dataset.latestSchemaVersion}` : "–"}</span></Td>
                    <Td>
                      {dataset.qualityStatus === "failing" ? <Badge tone="danger">failing</Badge>
                        : dataset.qualityStatus === "passing" ? <Badge tone="success">passing</Badge>
                        : <Badge tone="neutral">unknown</Badge>}
                    </Td>
                    <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatRelative(dataset.lastUpdatedAt)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </Card>
    </div>
  );
}
