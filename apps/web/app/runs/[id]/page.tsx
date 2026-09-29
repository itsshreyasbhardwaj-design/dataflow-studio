import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission, services } from "@dataflow-studio/api";
import { getServerContext } from "@/lib/server";
import { RunView } from "@/components/run-view";
import { CancelRunButton, RetryRunButton } from "@/components/actions";
import { Badge, Banner, Card, CardHeader, StateBadge } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getServerContext();

  const detail = await services.runs.getRun(context, id).catch(() => null);
  if (!detail) notFound();

  const { run, tasks, graph, quality } = detail;
  const inFlight = ["RUNNING", "QUEUED", "PENDING"].includes(run.state);
  const evidence = run.state === "FAILED" ? await services.runs.investigateRun(context, id).catch(() => null) : null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[18px] font-semibold tracking-tight">
            <Link href={`/pipelines/${run.pipelineId}`} className="hover:text-[var(--color-accent)]">{run.pipelineName}</Link>
            <span className="mono text-[13px] font-normal text-[var(--color-text-subtle)]">v{run.version}</span>
            {run.isDemo && <Badge tone="warning">DEMO</Badge>}
          </h1>
          <dl className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
            <Pair label="Run ID" value={<span className="mono">{run.id}</span>} />
            <Pair label="Started" value={formatDateTime(run.startedAt ?? run.queuedAt)} />
            <Pair label="Duration" value={<span className="mono">{formatDuration(run.durationMs)}</span>} />
            <Pair label="Status" value={<StateBadge state={run.state} />} />
            <Pair label="Triggered by" value={<span className="mono">{run.triggeredBy} ({run.trigger})</span>} />
            {run.logicalDate && <Pair label="Logical date" value={<span className="mono">{run.logicalDate.slice(0, 19).replace("T", " ")}</span>} />}
          </dl>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {inFlight && hasPermission(context.principal.role, "pipeline.cancel") && <CancelRunButton runId={id} />}
          {!inFlight && hasPermission(context.principal.role, "pipeline.execute") && <RetryRunButton runId={id} />}
        </div>
      </div>

      {run.error && <Banner tone="danger" title="Run failed">{run.error}</Banner>}
      {run.retryOfRunId && (
        <Banner tone="info">
          This run is a retry of <Link className="mono underline" href={`/runs/${run.retryOfRunId}`}>{run.retryOfRunId}</Link>.
        </Banner>
      )}

      <RunView
        runId={id}
        initialState={run.state}
        tasks={tasks.map((task) => ({
          id: task.id,
          nodeId: task.nodeId,
          nodeType: task.nodeType,
          state: task.state,
          attempt: task.attempt,
          maxAttempts: task.maxAttempts,
          startedAt: task.startedAt ?? null,
          finishedAt: task.finishedAt ?? null,
          durationMs: task.durationMs ?? null,
          error: task.error ?? null,
          errorClass: task.errorClass ?? null,
          output: (task.output ?? null) as Record<string, unknown> | null,
          dependsOn: task.dependsOn,
        }))}
        graph={graph}
        quality={quality.map((result) => ({
          checkId: result.checkId,
          checkType: result.checkType,
          ...(result.column ? { column: result.column } : {}),
          status: result.status,
          severity: result.severity,
          expected: result.expected,
          actual: result.actual,
          failedRows: result.failedRows,
          totalRows: result.totalRows,
          message: result.message,
        }))}
        canCancel={hasPermission(context.principal.role, "pipeline.cancel")}
      />

      {evidence && (
        <Card>
          <CardHeader
            title="Failure investigation"
            description="Evidence gathered from stored records. No cause is inferred."
          />
          <div className="space-y-3 p-4 text-[12.5px]">
            {evidence.failedTask && (
              <div>
                <span className="text-[var(--color-text-subtle)]">First failed task: </span>
                <span className="mono font-medium">{evidence.failedTask.nodeId}</span>
                <span className="text-[var(--color-text-muted)]"> ({evidence.failedTask.nodeType})</span>
                {evidence.failedTask.errorClass && <Badge className="ml-2" tone="danger" mono>{evidence.failedTask.errorClass}</Badge>}
                <p className="mono mt-1 whitespace-pre-wrap text-[var(--color-danger)]">{evidence.failedTask.error}</p>
              </div>
            )}
            <div>
              <span className="text-[var(--color-text-subtle)]">Recurrence: </span>
              {evidence.recurrence.runs > 1
                ? <>this node has failed in <strong>{evidence.recurrence.runs}</strong> of the last 20 runs</>
                : <>first failure of this node in the last 20 runs</>}
            </div>
            <div>
              <span className="text-[var(--color-text-subtle)]">Last successful run: </span>
              {evidence.lastSuccessfulRun
                ? <Link className="mono underline" href={`/runs/${evidence.lastSuccessfulRun.id}`}>{evidence.lastSuccessfulRun.id}</Link>
                : "none recorded"}
            </div>
            {evidence.versionDiff && (
              <div>
                <span className="text-[var(--color-text-subtle)]">Changed since then: </span>
                <ul className="mono mt-1 space-y-0.5">
                  {evidence.versionDiff.summary.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
              </div>
            )}
            {evidence.qualityFailures.length > 0 && (
              <div>
                <span className="text-[var(--color-text-subtle)]">Quality failures in this run: </span>
                <ul className="mt-1 space-y-0.5">
                  {evidence.qualityFailures.map((result) => (
                    <li key={result.id} className="mono">
                      {result.checkId} · expected {result.expected} · actual {result.actual}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {evidence.affectedTasks.length > 0 && (
              <div>
                <span className="text-[var(--color-text-subtle)]">Blast radius: </span>
                <span className="mono">{evidence.affectedTasks.map((task) => `${task.nodeId} (${task.state})`).join(", ")}</span>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-[var(--color-text-subtle)]">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
