import Link from "next/link";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { Badge, Button, Card, EmptyState, Table, Td, Th } from "@/components/ui";
import { IncidentActions } from "@/components/actions";
import { formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Incidents" };

const STATUSES = ["open", "acknowledged", "resolved"] as const;

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const query = await searchParams;
  const status = (STATUSES as readonly string[]).includes(query.status ?? "") ? query.status! : "open";
  const context = await getServerContext();
  const page = await services.catalog.listIncidents(context, { status: status as "open", limit: 100 });

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Incidents</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Opened automatically from stored evidence: repeated failures, duration spikes, quality failures,
            schema drift, missing data and stale datasets.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {STATUSES.map((option) => (
            <Link key={option} href={`/incidents?status=${option}`}>
              <Button size="sm" variant={status === option ? "primary" : "secondary"}>{option}</Button>
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {page.items.length === 0
          ? <EmptyState title={`No ${status} incidents`} description={status === "open" ? "Nothing is currently wrong that the detectors can see." : undefined} />
          : (
            <Table>
              <thead>
                <tr>
                  <Th>Severity</Th><Th>Incident</Th><Th>Kind</Th><Th align="right">Seen</Th>
                  <Th align="right">First</Th><Th align="right">Last</Th><Th />
                </tr>
              </thead>
              <tbody>
                {page.items.map((incident) => (
                  <tr key={incident.id} className="align-top hover:bg-[var(--color-surface-raised)]">
                    <Td>
                      <Badge tone={incident.severity === "high" ? "danger" : incident.severity === "medium" ? "warning" : "neutral"}>
                        {incident.severity}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="font-medium">{incident.title}</div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-[var(--color-text-subtle)]">Evidence</summary>
                        <pre className="mono mt-1 max-w-xl overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 text-[10.5px]">
                          {JSON.stringify(incident.evidence, null, 2)}
                        </pre>
                      </details>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                        {incident.pipelineId && (
                          <Link href={`/pipelines/${incident.pipelineId}`} className="text-[var(--color-accent)]">pipeline</Link>
                        )}
                        {incident.runId && (
                          <Link href={`/runs/${incident.runId}`} className="text-[var(--color-accent)]">run</Link>
                        )}
                        {incident.dataset && (
                          <Link href={`/datasets/${encodeURIComponent(incident.dataset)}`} className="text-[var(--color-accent)]">dataset</Link>
                        )}
                      </div>
                    </Td>
                    <Td><span className="mono text-[11.5px]">{incident.kind}</span></Td>
                    <Td align="right"><span className="mono">{incident.occurrences}×</span></Td>
                    <Td align="right"><span className="text-[11px] text-[var(--color-text-muted)]">{formatDateTime(incident.firstSeenAt)}</span></Td>
                    <Td align="right"><span className="text-[11px] text-[var(--color-text-muted)]">{formatRelative(incident.lastSeenAt)}</span></Td>
                    <Td align="right"><IncidentActions incidentId={incident.id} status={incident.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </Card>
    </div>
  );
}
