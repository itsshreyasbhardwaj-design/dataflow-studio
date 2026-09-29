import Link from "next/link";
import { notFound } from "next/navigation";
import { services } from "@dataflow-studio/api";
import { hasPermission } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import {
  Badge, Banner, Button, Card, CardHeader, EmptyState, StateBadge, Table, Td, Th,
} from "@/components/ui";
import { BackfillDialog, DeleteButton, PublishButton, RunPipelineButton, ScheduleDialog } from "@/components/actions";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getServerContext();

  const detail = await services.pipelines.getPipeline(context, id).catch(() => null);
  if (!detail) notFound();

  const backfills = await services.schedules.listBackfills(context, id);
  const role = context.principal.role;
  const published = detail.versions.find((version) => version.status === "published");
  const draft = detail.versions.find((version) => version.status === "draft");

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[18px] font-semibold tracking-tight">{detail.pipeline.name}</h1>
            {detail.pipeline.isDemo && <Badge tone="warning">DEMO</Badge>}
            {published ? <Badge tone="success" mono>published v{published.version}</Badge> : <Badge tone="neutral">never published</Badge>}
            {draft && <Badge tone="accent" mono>draft v{draft.version}</Badge>}
          </div>
          {detail.pipeline.description && (
            <p className="mt-1 max-w-3xl text-[12.5px] text-[var(--color-text-muted)]">{detail.pipeline.description}</p>
          )}
          <p className="mono mt-1 text-[11px] text-[var(--color-text-subtle)]">{detail.pipeline.id}</p>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <Link href={`/pipelines/${id}/editor`}><Button size="sm">Open editor</Button></Link>
          <RunPipelineButton
            pipelineId={id}
            disabled={!hasPermission(role, "pipeline.execute") || !published}
            {...(published ? {} : { hint: "Publish the pipeline first" })}
          />
          {draft && <PublishButton pipelineId={id} disabled={!hasPermission(role, "workflow.publish")} />}
          <ScheduleDialog pipelineId={id} disabled={!hasPermission(role, "workflow.schedule") || !published} />
          <BackfillDialog pipelineId={id} disabled={!hasPermission(role, "backfill.create") || !published} />
          {hasPermission(role, "pipeline.delete") && (
            <DeleteButton
              path={`/api/v1/pipelines/${id}`}
              label="Delete"
              confirmText="Deleting a pipeline removes its versions. Run history is removed with it."
            />
          )}
        </div>
      </div>

      {detail.validation && !detail.validation.valid && (
        <Banner tone="danger" title="The current version does not validate">
          <ul className="mt-1 space-y-1">
            {detail.validation.errors.map((issue, index) => (
              <li key={index}>
                {issue.nodeId && <span className="mono">[{issue.nodeId}] </span>}
                {issue.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent runs"
            actions={<Link href={`/pipelines/${id}/runs`} className="text-[12px] text-[var(--color-accent)]">All runs</Link>}
          />
          {detail.recentRuns.length === 0
            ? <EmptyState title="No runs yet" description={published ? "Trigger a run to see it here." : "Publish the pipeline, then trigger a run."} />
            : (
              <Table>
                <thead><tr><Th>Run</Th><Th>Version</Th><Th>State</Th><Th>Trigger</Th><Th align="right">Duration</Th><Th align="right">Started</Th></tr></thead>
                <tbody>
                  {detail.recentRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-[var(--color-surface-raised)]">
                      <Td><Link href={`/runs/${run.id}`} className="mono hover:text-[var(--color-accent)]">{run.id}</Link></Td>
                      <Td><span className="mono">v{run.version}</span></Td>
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
            <CardHeader title="Versions" description="Publishing deprecates the previous version; it is never overwritten." />
            <ul className="divide-y divide-[var(--color-border)]">
              {detail.versions.map((version) => (
                <li key={version.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="mono font-medium">v{version.version}</span>
                      <Badge tone={version.status === "published" ? "success" : version.status === "draft" ? "accent" : "neutral"}>
                        {version.status}
                      </Badge>
                    </span>
                    {detail.versions.length > 1 && version.version > 1 && (
                      <Link
                        href={`/pipelines/${id}?compare=${version.version - 1}-${version.version}`}
                        className="text-[11.5px] text-[var(--color-accent)]"
                      >
                        diff v{version.version - 1}→v{version.version}
                      </Link>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">
                    {formatDateTime(version.publishedAt ?? version.createdAt)} · {version.createdBy}
                  </div>
                  {version.changeSummary?.length ? (
                    <ul className="mono mt-1 space-y-0.5 text-[10.5px] text-[var(--color-text-muted)]">
                      {version.changeSummary.slice(1, 5).map((line, index) => <li key={index}>{line}</li>)}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Schedules" />
            {detail.schedules.length === 0
              ? <div className="px-4 py-5 text-center text-[12.5px] text-[var(--color-text-subtle)]">No schedules.</div>
              : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {detail.schedules.map((schedule) => (
                    <li key={schedule.id} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="mono text-[12px]">{schedule.cron ?? `every ${schedule.intervalSeconds}s`}</span>
                        <Badge tone={schedule.enabled ? "success" : "neutral"}>{schedule.enabled ? "enabled" : "paused"}</Badge>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">
                        {schedule.timezone} · next {formatRelative(schedule.nextRunAt)}
                        {schedule.catchup ? " · catchup on" : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </Card>

          {backfills.length > 0 && (
            <Card>
              <CardHeader title="Backfills" />
              <ul className="divide-y divide-[var(--color-border)]">
                {backfills.slice(0, 5).map((backfill) => (
                  <li key={backfill.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-[11.5px]">{backfill.from.slice(0, 10)} → {backfill.to.slice(0, 10)}</span>
                      <Badge tone={backfill.state === "completed" ? "success" : backfill.state === "failed" ? "danger" : "info"}>
                        {backfill.state}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">
                      {backfill.completedRuns + backfill.failedRuns}/{backfill.totalRuns} runs
                      {backfill.failedRuns ? ` · ${backfill.failedRuns} failed` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
