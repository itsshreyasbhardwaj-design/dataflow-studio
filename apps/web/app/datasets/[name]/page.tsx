import Link from "next/link";
import { notFound } from "next/navigation";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DatasetPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  const context = await getServerContext();

  const detail = await services.catalog.getDataset(context, name).catch(() => null);
  if (!detail) notFound();

  const latest = detail.schemas.at(-1);
  const columns = latest?.columns ?? (detail.preview?.columns as Array<{ name: string; type: string; nullable: boolean }> | undefined) ?? [];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div>
        <h1 className="mono text-[18px] font-semibold tracking-tight">{detail.dataset.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
          <span>{formatNumber(detail.dataset.rowCount)} rows</span>
          <span>schema {latest ? `v${latest.version}` : "not registered"}</span>
          <span>updated {formatRelative(detail.dataset.lastUpdatedAt)}</span>
          {detail.dataset.sourceType && <span className="mono">{detail.dataset.sourceType}</span>}
          {detail.dataset.qualityStatus === "failing" && <Badge tone="danger">quality failing</Badge>}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Schema" description={latest ? `Version ${latest.version}, registered ${formatDateTime(latest.createdAt)}` : "No schema has been registered for this dataset."} />
          {columns.length === 0
            ? <EmptyState title="No columns recorded" />
            : (
              <Table>
                <thead><tr><Th>Column</Th><Th>Type</Th><Th>Nullable</Th></tr></thead>
                <tbody>
                  {columns.map((column) => (
                    <tr key={column.name}>
                      <Td><span className="mono">{column.name}</span></Td>
                      <Td><Badge mono>{column.type}</Badge></Td>
                      <Td><span className="text-[var(--color-text-muted)]">{column.nullable ? "yes" : "no"}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>

        <Card>
          <CardHeader title="Lineage" description="Derived from published pipeline definitions." />
          <div className="space-y-3 p-4 text-[12.5px]">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Upstream</div>
              {detail.upstream.length === 0
                ? <p className="mt-1 text-[var(--color-text-subtle)]">Nothing recorded.</p>
                : (
                  <ul className="mt-1 space-y-0.5">
                    {detail.upstream.map((node) => (
                      <li key={`${node.type}:${node.id}`} className="mono">
                        {node.type === "dataset"
                          ? <Link href={`/datasets/${encodeURIComponent(node.id)}`} className="text-[var(--color-accent)]">{node.id}</Link>
                          : node.id}
                      </li>
                    ))}
                  </ul>
                )}
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Downstream</div>
              {detail.downstream.length === 0
                ? <p className="mt-1 text-[var(--color-text-subtle)]">Nothing recorded.</p>
                : (
                  <ul className="mt-1 space-y-0.5">
                    {detail.downstream.map((node) => (
                      <li key={`${node.type}:${node.id}`} className="mono">
                        {node.type === "dataset"
                          ? <Link href={`/datasets/${encodeURIComponent(node.id)}`} className="text-[var(--color-accent)]">{node.id}</Link>
                          : node.id}
                      </li>
                    ))}
                  </ul>
                )}
            </div>
            {detail.producedBy.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Produced by</div>
                <ul className="mt-1 space-y-0.5">
                  {detail.producedBy.map((producer) => (
                    <li key={`${producer.pipelineId}:${producer.nodeId}`}>
                      <Link href={`/pipelines/${producer.pipelineId}`} className="text-[var(--color-accent)]">{producer.pipelineName || producer.pipelineId}</Link>
                      <span className="mono text-[var(--color-text-subtle)]"> · {producer.nodeId}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>

      {detail.latestChange && detail.latestChange.changes.length > 0 && (
        <Card>
          <CardHeader
            title="Latest schema change"
            description={`Classified ${detail.latestChange.classification} by deterministic rules`}
          />
          <Table>
            <thead><tr><Th>Column</Th><Th>Change</Th><Th>Classification</Th><Th>Why</Th></tr></thead>
            <tbody>
              {detail.latestChange.changes.map((change) => (
                <tr key={`${change.kind}:${change.column}`}>
                  <Td><span className="mono">{change.column}</span></Td>
                  <Td><span className="mono text-[11.5px]">{change.kind.replace(/_/g, " ")}</span></Td>
                  <Td>
                    <Badge tone={change.classification === "BREAKING" ? "danger" : change.classification === "WARNING" ? "warning" : "success"}>
                      {change.classification}
                    </Badge>
                  </Td>
                  <Td><span className="text-[11.5px] text-[var(--color-text-muted)]">{change.reason}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Quality results" description="Most recent checks recorded against this dataset." />
          {detail.quality.length === 0
            ? <EmptyState title="No quality results" description="Add a quality check node upstream of the destination." />
            : (
              <Table>
                <thead><tr><Th>Check</Th><Th>Column</Th><Th>Actual</Th><Th>Status</Th><Th align="right">When</Th></tr></thead>
                <tbody>
                  {detail.quality.slice(0, 12).map((result) => (
                    <tr key={result.id}>
                      <Td><span className="mono">{result.checkId}</span></Td>
                      <Td>{result.column ? <span className="mono">{result.column}</span> : "–"}</Td>
                      <Td><span className="mono">{result.actual}</span></Td>
                      <Td><Badge tone={result.status === "PASSED" ? "success" : "danger"} mono>{result.status}</Badge></Td>
                      <Td align="right"><span className="text-[11px] text-[var(--color-text-muted)]">{formatRelative(result.createdAt)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>

        <Card>
          <CardHeader
            title="Preview"
            description={detail.preview ? `${formatNumber(detail.preview.rowCount)} rows stored · showing up to 25` : "No stored rows for this dataset."}
          />
          {!detail.preview || detail.preview.rows.length === 0
            ? <EmptyState title="No preview available" description="Managed datasets retain a bounded preview; external destinations do not." />
            : (
              <div className="max-h-80 overflow-auto">
                <Table>
                  <thead>
                    <tr>{columns.slice(0, 8).map((column) => <Th key={column.name}>{column.name}</Th>)}</tr>
                  </thead>
                  <tbody>
                    {detail.preview.rows.slice(0, 25).map((row, index) => (
                      <tr key={index}>
                        {columns.slice(0, 8).map((column) => (
                          <Td key={column.name}>
                            <span className="mono">{formatCell((row as Record<string, unknown>)[column.name])}</span>
                          </Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
        </Card>
      </div>

      {detail.schemas.length > 1 && (
        <Card>
          <CardHeader title="Schema history" />
          <Table>
            <thead><tr><Th>Version</Th><Th align="right">Columns</Th><Th>Fingerprint</Th><Th align="right">Registered</Th></tr></thead>
            <tbody>
              {[...detail.schemas].reverse().map((schema) => (
                <tr key={schema.version}>
                  <Td><span className="mono">v{schema.version}</span></Td>
                  <Td align="right"><span className="mono">{schema.columns.length}</span></Td>
                  <Td><span className="mono text-[11px] text-[var(--color-text-subtle)]">{schema.fingerprint}</span></Td>
                  <Td align="right"><span className="text-[11.5px] text-[var(--color-text-muted)]">{formatDateTime(schema.createdAt)}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
