import { services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { DurationChart, RunVolumeChart, SuccessRateChart, TaskFailureChart } from "@/components/charts";
import { Card, CardHeader, StatCard, Table, Td, Th } from "@/components/ui";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

const WINDOWS = [7, 14, 30, 90] as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string; pipelineId?: string }> }) {
  const query = await searchParams;
  const days = WINDOWS.includes(Number(query.days) as 7) ? Number(query.days) : 30;
  const context = await getServerContext();

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const [analytics, pipelines] = await Promise.all([
    services.analytics.getAnalytics(context, {
      from: from.toISOString(),
      to: to.toISOString(),
      ...(query.pipelineId ? { pipelineId: query.pipelineId } : {}),
    }),
    services.pipelines.listPipelines(context, { limit: 100 }),
  ]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Analytics</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Aggregated from {formatNumber(analytics.totals.runs)} run record{analytics.totals.runs === 1 ? "" : "s"} in the selected window.
          </p>
        </div>
        <form action="/analytics" className="flex items-center gap-2">
          <select
            name="pipelineId"
            defaultValue={query.pipelineId ?? ""}
            aria-label="Pipeline"
            className="h-8 w-48 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px]"
          >
            <option value="">All pipelines</option>
            {pipelines.items.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
          </select>
          <select
            name="days"
            defaultValue={String(days)}
            aria-label="Window"
            className="h-8 w-28 rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px]"
          >
            {WINDOWS.map((option) => <option key={option} value={option}>{option} days</option>)}
          </select>
          <button type="submit" className="h-8 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-3 text-[13px]">
            Apply
          </button>
        </form>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Runs" value={formatNumber(analytics.totals.runs)} />
        <StatCard label="Succeeded" value={formatNumber(analytics.totals.succeeded)} tone="success" />
        <StatCard label="Failed" value={formatNumber(analytics.totals.failed)} tone={analytics.totals.failed ? "danger" : "neutral"} />
        <StatCard label="Success rate" value={formatPercent(analytics.successRate)} />
        <StatCard label="Average duration" value={formatDuration(analytics.averageDurationMs)} />
        <StatCard label="p95 duration" value={formatDuration(analytics.p95DurationMs)} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Run volume" />
          <div className="p-3"><RunVolumeChart data={analytics.series} /></div>
        </Card>
        <Card>
          <CardHeader title="Success rate" />
          <div className="p-3"><SuccessRateChart data={analytics.series} /></div>
        </Card>
        <Card>
          <CardHeader title="Execution duration" />
          <div className="p-3"><DurationChart data={analytics.series} /></div>
        </Card>
        <Card>
          <CardHeader title="Task failure distribution" />
          <div className="p-3"><TaskFailureChart data={analytics.taskFailures} /></div>
        </Card>
      </section>

      <Card>
        <CardHeader title="Daily detail" description="The exact numbers behind the charts." />
        <Table>
          <thead>
            <tr><Th>Date</Th><Th align="right">Succeeded</Th><Th align="right">Failed</Th><Th align="right">Cancelled</Th><Th align="right">Average duration</Th></tr>
          </thead>
          <tbody>
            {analytics.series.length === 0 && (
              <tr><Td className="text-center text-[var(--color-text-subtle)]" align="center">No runs in this window.</Td></tr>
            )}
            {[...analytics.series].reverse().map((point) => (
              <tr key={point.date}>
                <Td><span className="mono">{point.date}</span></Td>
                <Td align="right"><span className="mono">{point.succeeded}</span></Td>
                <Td align="right"><span className="mono text-[var(--color-danger)]">{point.failed || ""}</span></Td>
                <Td align="right"><span className="mono">{point.cancelled || ""}</span></Td>
                <Td align="right"><span className="mono">{formatDuration(point.averageDurationMs)}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
