import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock } from "lucide-react";
import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { DurationChart, RunVolumeChart, SuccessRateChart, TaskFailureChart } from "@/components/charts";
import { Badge, Banner, Card, CardHeader, EmptyState, StateBadge, StatCard, Table, Td, Th } from "@/components/ui";
import { SeedDemoButton } from "@/components/actions";
import { formatDuration, formatNumber, formatPercent, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const context = await getServerContext();
  const dashboard = await services.analytics.getDashboard(context, { days: 14 });
  const empty = dashboard.runs.total === 0 && dashboard.pipelines.total === 0;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Every figure below is computed from stored execution records over the last 14 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dashboard.demoOnly && <Badge tone="warning">Demo data only</Badge>}
          <Badge tone={dashboard.storeDriver === "postgres" ? "success" : "warning"} mono>
            {dashboard.storeDriver}
          </Badge>
        </div>
      </div>

      {empty && (
        <Card>
          <EmptyState
            title="Nothing has run yet"
            description="Seed a demo pipeline to see the whole lifecycle - design, validation, execution, quality gates and lineage - with no external systems. Demo records are labelled and can be deleted."
            action={<SeedDemoButton />}
          />
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Pipelines" value={formatNumber(dashboard.pipelines.total)} hint={`${dashboard.pipelines.active} active`} href="/pipelines" />
        <StatCard label="Scheduled" value={formatNumber(dashboard.pipelines.scheduled)} hint="with an enabled schedule" />
        <StatCard label="Running" value={formatNumber(dashboard.runs.running)} tone={dashboard.runs.running ? "info" : "neutral"} hint={`${dashboard.runs.queued} queued`} href="/runs" />
        <StatCard label="Succeeded" value={formatNumber(dashboard.runs.succeeded)} tone="success" href="/runs?state=SUCCESS" />
        <StatCard label="Failed" value={formatNumber(dashboard.runs.failed)} tone={dashboard.runs.failed ? "danger" : "neutral"} href="/runs?state=FAILED" />
        <StatCard label="Avg runtime" value={formatDuration(dashboard.performance.averageDurationMs)} hint={`p95 ${formatDuration(dashboard.performance.p95DurationMs)}`} />
        <StatCard
          label="Quality failures"
          value={formatNumber(dashboard.quality.failures)}
          tone={dashboard.quality.failures ? "warning" : "neutral"}
          hint={`success rate ${formatPercent(dashboard.performance.successRate)}`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Workflow runs" description="Runs per day by outcome" />
          <div className="p-3"><RunVolumeChart data={dashboard.analytics.series} /></div>
        </Card>
        <Card>
          <CardHeader title="Success rate" description="Finished runs only" />
          <div className="p-3"><SuccessRateChart data={dashboard.analytics.series} /></div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Execution duration" description="Daily average" />
          <div className="p-3"><DurationChart data={dashboard.analytics.series} /></div>
        </Card>
        <Card>
          <CardHeader title="Task failure distribution" description="Most frequently failing nodes" />
          <div className="p-3"><TaskFailureChart data={dashboard.analytics.taskFailures} /></div>
        </Card>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent runs"
            actions={<Link href="/runs" className="flex items-center gap-1 text-[12px] text-[var(--color-accent)]">All runs <ArrowRight className="size-3" /></Link>}
          />
          {dashboard.recentRuns.length === 0
            ? <EmptyState title="No runs yet" description="Publish a pipeline and trigger it to see runs here." />
            : (
              <Table>
                <thead>
                  <tr><Th>Pipeline</Th><Th>State</Th><Th>Trigger</Th><Th align="right">Duration</Th><Th align="right">Started</Th></tr>
                </thead>
                <tbody>
                  {dashboard.recentRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-[var(--color-surface-raised)]">
                      <Td>
                        <Link href={`/runs/${run.id}`} className="font-medium hover:text-[var(--color-accent)]">
                          {run.pipelineName}
                        </Link>
                        <span className="ml-1.5 mono text-[var(--color-text-subtle)]">v{run.version}</span>
                        {run.isDemo && <Badge className="ml-2" tone="warning">DEMO</Badge>}
                      </Td>
                      <Td><StateBadge state={run.state} /></Td>
                      <Td><span className="mono text-[var(--color-text-muted)]">{run.trigger}</span></Td>
                      <Td align="right"><span className="mono">{formatDuration(run.durationMs)}</span></Td>
                      <Td align="right"><span className="text-[var(--color-text-muted)]">{formatRelative(run.queuedAt)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader
              title="Open incidents"
              actions={<Link href="/incidents" className="text-[12px] text-[var(--color-accent)]">View</Link>}
            />
            {dashboard.recentIncidents.length === 0
              ? <div className="px-4 py-6 text-center text-[12.5px] text-[var(--color-text-subtle)]">No open incidents.</div>
              : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {dashboard.recentIncidents.map((incident) => (
                    <li key={incident.id} className="px-4 py-2.5">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className={`mt-0.5 size-3.5 ${incident.severity === "high" ? "text-[var(--color-danger)]" : "text-[var(--color-warning)]"}`} aria-hidden />
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium">{incident.title}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-text-subtle)]">
                            <span className="mono">{incident.kind}</span>
                            <span>·</span>
                            <span>{incident.occurrences}×</span>
                            <span>·</span>
                            <span>{formatRelative(incident.lastSeenAt)}</span>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </Card>

          <Card>
            <CardHeader title="Scheduled next" />
            {dashboard.upcomingSchedules.length === 0
              ? <div className="px-4 py-6 text-center text-[12.5px] text-[var(--color-text-subtle)]">No enabled schedules.</div>
              : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {dashboard.upcomingSchedules.map((schedule) => (
                    <li key={schedule.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <span className="flex items-center gap-2 text-[12.5px]">
                        <Clock className="size-3.5 text-[var(--color-text-subtle)]" aria-hidden />
                        <span className="mono">{schedule.cron ?? `${schedule.intervalSeconds}s`}</span>
                      </span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">{formatRelative(schedule.nextRunAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>
      </section>

      {dashboard.storeDriver === "memory" && (
        <Banner tone="warning" title="Development store">
          This deployment is using the in-memory store: state is lost on restart and a separate worker
          process cannot see it. Set <span className="mono">DATABASE_URL</span> to run PostgreSQL with
          independent workers.
        </Banner>
      )}
    </div>
  );
}
