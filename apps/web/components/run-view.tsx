"use client";

import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { api, type ClientError } from "./api-client";
import { nodeTypes, type DagNodeData } from "./editor/dag-node";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Input, Select, Spinner, StateBadge, Table, Tabs, Td, Th } from "./ui";
import { formatDuration, formatNumber } from "@/lib/format";

export interface RunTask {
  id: string;
  nodeId: string;
  nodeType: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  errorClass?: string | null;
  output?: Record<string, unknown> | null;
  dependsOn: string[];
}

export interface RunViewProps {
  runId: string;
  initialState: string;
  tasks: RunTask[];
  graph: {
    nodes: Array<{ id: string; type: string; label: string; position?: { x: number; y: number } }>;
    edges: Array<{ from: string; to: string; port?: string }>;
  };
  quality: Array<{
    checkId: string; checkType: string; column?: string; status: string; severity: string;
    expected: string; actual: string; failedRows: number; totalRows: number; message: string;
  }>;
  canCancel: boolean;
}

interface LogEntry {
  id: string;
  taskRunId: string;
  attempt: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

const LAYER_WIDTH = 240;
const LAYER_HEIGHT = 130;

/**
 * Live run view.
 *
 * Subscribes to the run's server-sent events rather than polling: task states,
 * log lines and the final outcome arrive as they happen, and a reconnect resumes
 * from the last sequence it saw.
 */
export function RunView({ runId, initialState, tasks: initialTasks, graph, quality, canCancel }: RunViewProps) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [runState, setRunState] = useState(initialState);
  const [live, setLive] = useState(false);
  const [tab, setTab] = useState("graph");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const terminal = ["SUCCESS", "FAILED", "CANCELLED"].includes(runState);

  const refreshTasks = useCallback(async () => {
    try {
      const detail = await api.get<{ run: { state: string }; tasks: RunTask[] }>(`/api/v1/runs/${runId}`);
      setTasks(detail.tasks);
      setRunState(detail.run.state);
    } catch {
      // A transient failure here is not worth interrupting the page for.
    }
  }, [runId]);

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`/api/v1/runs/${runId}/events`);
    setLive(true);

    const onTaskEvent = (): void => void refreshTasks();
    for (const type of ["task.started", "task.finished", "task.retrying", "task.blocked", "task.skipped", "task.queued"]) {
      source.addEventListener(type, onTaskEvent);
    }
    source.addEventListener("run.finished", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { state: string };
      setRunState(payload.state);
      setLive(false);
      source.close();
      void refreshTasks();
      router.refresh();
    });
    source.onerror = () => {
      setLive(false);
      source.close();
    };
    return () => {
      source.close();
      setLive(false);
    };
  }, [refreshTasks, router, runId, terminal]);

  const { nodes, edges } = useMemo(() => buildFlow(graph, tasks), [graph, tasks]);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  const counts = useMemo(() => ({
    total: tasks.length,
    succeeded: tasks.filter((task) => task.state === "SUCCESS").length,
    failed: tasks.filter((task) => task.state === "FAILED").length,
    blocked: tasks.filter((task) => task.state === "BLOCKED").length,
    running: tasks.filter((task) => task.state === "RUNNING").length,
  }), [tasks]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={runState} />
        {live && <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-accent)]"><Spinner /> live</span>}
        <span className="mono text-[11.5px] text-[var(--color-text-muted)]">
          {counts.succeeded}/{counts.total} tasks
          {counts.failed ? ` · ${counts.failed} failed` : ""}
          {counts.blocked ? ` · ${counts.blocked} blocked` : ""}
        </span>
      </div>

      <Tabs
        tabs={[
          { id: "graph", label: "Graph" },
          { id: "tasks", label: "Tasks", count: tasks.length },
          { id: "quality", label: "Data quality", count: quality.length },
          { id: "logs", label: "Logs" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "graph" && (
        <Card className="h-[460px] overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_event, node) => {
              const task = tasks.find((candidate) => candidate.nodeId === node.id);
              if (task) setSelectedTaskId(task.id);
            }}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-border)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </Card>
      )}

      {tab === "tasks" && (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Node</Th><Th>Type</Th><Th>State</Th><Th align="right">Attempt</Th>
                <Th align="right">Duration</Th><Th align="right">Rows</Th><Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="cursor-pointer hover:bg-[var(--color-surface-raised)]" onClick={() => setSelectedTaskId(task.id)}>
                  <Td><span className="font-medium">{task.nodeId}</span></Td>
                  <Td><span className="mono text-[var(--color-text-muted)]">{task.nodeType}</span></Td>
                  <Td><StateBadge state={task.state} /></Td>
                  <Td align="right"><span className="mono">{task.attempt}/{task.maxAttempts}</span></Td>
                  <Td align="right"><span className="mono">{formatDuration(task.durationMs)}</span></Td>
                  <Td align="right"><span className="mono">{rowsOf(task) ?? "–"}</span></Td>
                  <Td>
                    {task.error
                      ? <span className="truncate text-[11.5px] text-[var(--color-danger)]">{task.error}</span>
                      : <span className="text-[11.5px] text-[var(--color-text-subtle)]">View logs</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === "quality" && (
        <Card>
          {quality.length === 0
            ? <EmptyState title="No quality results" description="This run had no quality check nodes, so nothing was evaluated." />
            : (
              <Table>
                <thead>
                  <tr><Th>Check</Th><Th>Column</Th><Th>Expected</Th><Th>Actual</Th><Th align="right">Failed rows</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {quality.map((result) => (
                    <tr key={`${result.checkId}-${result.column ?? ""}`}>
                      <Td><span className="mono">{result.checkId}</span></Td>
                      <Td>{result.column ? <span className="mono">{result.column}</span> : "–"}</Td>
                      <Td><span className="text-[var(--color-text-muted)]">{result.expected}</span></Td>
                      <Td><span className="mono">{result.actual}</span></Td>
                      <Td align="right"><span className="mono">{formatNumber(result.failedRows)}/{formatNumber(result.totalRows)}</span></Td>
                      <Td>
                        <Badge tone={result.status === "PASSED" ? "success" : result.severity === "error" ? "danger" : "warning"} mono>
                          {result.status}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
        </Card>
      )}

      {tab === "logs" && <LogPanel runId={runId} live={!terminal} tasks={tasks} />}

      <TaskDialog
        runId={runId}
        task={selectedTask}
        canCancel={canCancel}
        onClose={() => setSelectedTaskId(null)}
      />
    </div>
  );
}

function rowsOf(task: RunTask): string | null {
  for (const key of ["rowsWritten", "rowsOut", "rowsRead", "groups"]) {
    const value = task.output?.[key];
    if (typeof value === "number") return value.toLocaleString("en-US");
  }
  return null;
}

/** Simple layered layout: depth from roots decides the column. */
function buildFlow(graph: RunViewProps["graph"], tasks: RunTask[]): { nodes: Node[]; edges: Edge[] } {
  const byNode = new Map(tasks.map((task) => [task.nodeId, task]));
  const upstream = new Map<string, string[]>();
  for (const node of graph.nodes) upstream.set(node.id, []);
  for (const edge of graph.edges) upstream.get(edge.to)?.push(edge.from);

  const depth = new Map<string, number>();
  const resolve = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = upstream.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map((parent) => resolve(parent, seen) + 1)) : 0;
    depth.set(id, value);
    return value;
  };
  for (const node of graph.nodes) resolve(node.id);

  const perLayer = new Map<number, number>();
  const nodes: Node[] = graph.nodes.map((node) => {
    const task = byNode.get(node.id);
    const layer = depth.get(node.id) ?? 0;
    const index = perLayer.get(layer) ?? 0;
    perLayer.set(layer, index + 1);
    return {
      id: node.id,
      type: "dataflow",
      position: node.position ?? { x: layer * LAYER_WIDTH, y: index * LAYER_HEIGHT },
      data: {
        label: node.label,
        nodeType: node.type,
        kind: node.type.split(".")[1] ?? "transform",
        ...(task ? {
          state: task.state,
          durationMs: task.durationMs ?? null,
          ...(task.error ? { issues: [{ message: task.error, severity: "error" as const }] } : {}),
        } : {}),
      } satisfies DagNodeData,
    };
  });

  const edges: Edge[] = graph.edges.map((edge) => {
    const state = byNode.get(edge.to)?.state;
    return {
      id: `${edge.from}->${edge.to}:${edge.port ?? "default"}`,
      source: edge.from,
      target: edge.to,
      ...(edge.port && edge.port !== "default" ? { sourceHandle: edge.port, label: edge.port } : {}),
      animated: state === "RUNNING",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      labelStyle: { fontSize: 10, fill: "var(--color-text-subtle)" },
      labelBgStyle: { fill: "var(--color-surface)" },
    };
  });

  return { nodes, edges };
}

function LogPanel({ runId, live, tasks }: { runId: string; live: boolean; tasks: RunTask[] }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState("");
  const [taskFilter, setTaskFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [follow, setFollow] = useState(live);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "500" });
      if (level) query.set("level", level);
      if (taskFilter) query.set("taskRunId", taskFilter);
      if (search) query.set("search", search);
      const page = await api.get<{ items: LogEntry[] }>(`/api/v1/runs/${runId}/logs?${query.toString()}`);
      setEntries(page.items);
    } finally {
      setLoading(false);
    }
  }, [level, runId, search, taskFilter]);

  useEffect(() => {
    const handle = setTimeout(() => void load(), 200);
    return () => clearTimeout(handle);
  }, [load]);

  useEffect(() => {
    if (!live || !follow) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [follow, live, load]);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, follow]);

  return (
    <Card>
      <CardHeader
        title="Task logs"
        description="Structured, credential-redacted log lines with the task and attempt that produced them."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-[var(--color-text-subtle)]" aria-hidden />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search logs" className="w-40 pl-7" />
            </div>
            <Select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Minimum level" className="w-28">
              <option value="">All levels</option>
              {["debug", "info", "warn", "error"].map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
            <Select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)} aria-label="Task" className="w-40">
              <option value="">All tasks</option>
              {tasks.map((task) => <option key={task.id} value={task.id}>{task.nodeId}</option>)}
            </Select>
            {live && (
              <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
                follow
              </label>
            )}
          </div>
        }
      />
      <div className="max-h-[420px] overflow-y-auto bg-[var(--color-canvas)] p-2">
        {loading && !entries.length && <div className="flex items-center gap-2 p-3 text-[12px] text-[var(--color-text-subtle)]"><Spinner /> Loading logs…</div>}
        {!loading && !entries.length && <div className="p-4 text-center text-[12.5px] text-[var(--color-text-subtle)]">No log lines match these filters.</div>}
        <pre className="mono whitespace-pre-wrap leading-relaxed">
          {entries.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span className="shrink-0 text-[var(--color-text-subtle)]">{entry.timestamp.slice(11, 19)}</span>
              <span className={clsx(
                "w-10 shrink-0 font-semibold",
                entry.level === "error" && "text-[var(--color-danger)]",
                entry.level === "warn" && "text-[var(--color-warning)]",
                entry.level === "info" && "text-[var(--color-info)]",
                entry.level === "debug" && "text-[var(--color-text-subtle)]",
              )}>
                {entry.level.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 break-words">{entry.message}</span>
            </div>
          ))}
        </pre>
        <div ref={bottomRef} />
      </div>
    </Card>
  );
}

function TaskDialog({ runId, task, canCancel, onClose }: { runId: string; task: RunTask | null; canCancel: boolean; onClose: () => void }) {
  const [detail, setDetail] = useState<{
    attempts: Array<{ attempt: number; state: string; startedAt: string; durationMs?: number | null; error?: string | null; errorClass?: string | null }>;
    logs: LogEntry[];
    config: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    if (!task) { setDetail(null); return; }
    void (async () => {
      try {
        setDetail(await api.get(`/api/v1/runs/${runId}/tasks/${task.id}`));
      } catch (caught) {
        setError(caught as ClientError);
      }
    })();
  }, [runId, task]);

  if (!task) return null;

  return (
    <Dialog open onClose={onClose} title={task.nodeId} description={task.nodeType} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
          <Metric label="State" value={<StateBadge state={task.state} />} />
          <Metric label="Attempt" value={<span className="mono">{task.attempt}/{task.maxAttempts}</span>} />
          <Metric label="Duration" value={<span className="mono">{formatDuration(task.durationMs)}</span>} />
          <Metric label="Rows" value={<span className="mono">{rowsOf(task) ?? "–"}</span>} />
        </div>

        {task.error && (
          <div className="rounded border border-[color-mix(in_oklch,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] p-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
              Error{task.errorClass ? ` · ${task.errorClass}` : ""}
            </div>
            <p className="mono mt-1 whitespace-pre-wrap">{task.error}</p>
          </div>
        )}

        {task.dependsOn.length > 0 && (
          <div className="text-[12px]">
            <span className="text-[var(--color-text-subtle)]">Inputs: </span>
            <span className="mono">{task.dependsOn.join(", ")}</span>
          </div>
        )}

        {detail && (
          <>
            <section>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Attempts</h4>
              <Table>
                <thead><tr><Th>#</Th><Th>State</Th><Th>Started</Th><Th align="right">Duration</Th><Th>Error</Th></tr></thead>
                <tbody>
                  {detail.attempts.map((attempt) => (
                    <tr key={attempt.attempt}>
                      <Td><span className="mono">{attempt.attempt}</span></Td>
                      <Td><StateBadge state={attempt.state} /></Td>
                      <Td><span className="mono text-[var(--color-text-muted)]">{attempt.startedAt.slice(11, 19)}</span></Td>
                      <Td align="right"><span className="mono">{formatDuration(attempt.durationMs)}</span></Td>
                      <Td><span className="text-[11.5px] text-[var(--color-danger)]">{attempt.error ?? ""}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>

            <section>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Configuration</h4>
              <pre className="max-h-40 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 mono">
                {JSON.stringify(detail.config, null, 2)}
              </pre>
            </section>

            <section>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Logs</h4>
              <pre className="max-h-48 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 mono whitespace-pre-wrap">
                {detail.logs.map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`).join("\n") || "No log lines."}
              </pre>
            </section>

            {task.output && Object.keys(task.output).length > 0 && (
              <section>
                <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">Output metadata</h4>
                <pre className="max-h-32 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 mono">
                  {JSON.stringify(task.output, null, 2)}
                </pre>
              </section>
            )}
          </>
        )}

        {error && <p className="text-[12px] text-[var(--color-danger)]">{error.message}</p>}

        {canCancel && ["RUNNING", "QUEUED", "PENDING", "RETRYING"].includes(task.state) && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => void api.post(`/api/v1/runs/${runId}/tasks/${task.id}/cancel`).then(onClose)}
          >
            Cancel this task
          </Button>
        )}
      </div>
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded border border-[var(--color-border)] px-2 py-1.5">
      <div className="text-[10.5px] uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}
