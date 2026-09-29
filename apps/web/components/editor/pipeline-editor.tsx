"use client";

import "@xyflow/react/dist/style.css";
import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type OnConnect,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Play, Plus, Save, Trash2, Upload, WandSparkles } from "lucide-react";
import {
  getNodeType, listNodeTypes, type NodeKind, type ValidationResult, type WorkflowDefinition, type WorkflowNode,
} from "@dataflow-studio/workflow-engine";
import { api, issuesOf, type ClientError } from "../api-client";
import { Badge, Banner, Button, Dialog, EmptyState, KeyHint, Spinner, Table, Td, Th } from "../ui";
import { ConfigPanel } from "./config-panel";
import { nodeTypes, type DagNodeData } from "./dag-node";

export interface PipelineEditorProps {
  pipelineId: string;
  pipelineName: string;
  definition: WorkflowDefinition;
  versionStatus: string;
  versionNumber: number;
  secrets: string[];
  connections: Array<{ id: string; name: string; family: string }>;
  canEdit: boolean;
  canPublish: boolean;
  canRun: boolean;
}

interface PreviewState {
  rows: Array<Record<string, unknown>>;
  profile: Array<{ name: string; type: string; nullable: boolean; nullCount: number; uniqueCount: number }>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

const KIND_GROUPS: Array<{ label: string; kinds: NodeKind[] }> = [
  { label: "Sources", kinds: ["source"] },
  { label: "Transform", kinds: ["sql", "transform", "filter", "aggregate", "join", "python"] },
  { label: "Quality", kinds: ["validate", "quality_gate"] },
  { label: "Destinations", kinds: ["destination"] },
  { label: "Control", kinds: ["http", "webhook", "delay", "condition"] },
];

function toFlowNodes(definition: WorkflowDefinition, validation: ValidationResult | null): Node[] {
  return definition.nodes.map((node, index) => {
    const registry = getNodeType(node.type);
    const issues = [
      ...(validation?.errors ?? []).filter((issue) => issue.nodeId === node.id).map((issue) => ({ message: issue.message, severity: "error" as const })),
      ...(validation?.warnings ?? []).filter((issue) => issue.nodeId === node.id).map((issue) => ({ message: issue.message, severity: "warning" as const })),
    ];
    const position = (node.metadata?.["position"] as { x: number; y: number } | undefined) ?? {
      x: (index % 4) * 260,
      y: Math.floor(index / 4) * 150,
    };
    return {
      id: node.id,
      type: "dataflow",
      position,
      data: {
        label: (node.metadata?.["label"] as string | undefined) ?? node.id,
        nodeType: node.type,
        kind: registry?.kind ?? "transform",
        issues,
        subtitle: subtitleFor(node),
      } satisfies DagNodeData,
    };
  });
}

function subtitleFor(node: WorkflowNode): string | undefined {
  const config = (node.config ?? {}) as Record<string, unknown>;
  for (const key of ["table", "dataset", "url", "key", "preset", "expression"]) {
    if (typeof config[key] === "string" && config[key]) return String(config[key]);
  }
  return undefined;
}

function toFlowEdges(definition: WorkflowDefinition): Edge[] {
  return definition.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}:${edge.port ?? "default"}`,
    source: edge.from,
    target: edge.to,
    ...(edge.port && edge.port !== "default" ? { sourceHandle: edge.port, label: edge.port } : {}),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    labelStyle: { fontSize: 10, fill: "var(--color-text-subtle)" },
    labelBgStyle: { fill: "var(--color-surface)" },
  }));
}

export function PipelineEditor(props: PipelineEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorCanvas {...props} />
    </ReactFlowProvider>
  );
}

function EditorCanvas({
  pipelineId, pipelineName, definition: initialDefinition, versionStatus, versionNumber,
  secrets, connections, canEdit, canPublish, canRun,
}: PipelineEditorProps) {
  const router = useRouter();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [definition, setDefinition] = useState<WorkflowDefinition>(initialDefinition);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toFlowNodes(initialDefinition, null));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(initialDefinition));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the canvas in step with the definition, preserving node positions.
  const syncCanvas = useCallback((next: WorkflowDefinition, result: ValidationResult | null) => {
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      return toFlowNodes(next, result).map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    });
    setEdges(toFlowEdges(next));
  }, [setNodes, setEdges]);

  /** Validation runs on the server, so the editor and the engine agree. */
  const validateNow = useCallback(async (candidate: WorkflowDefinition) => {
    try {
      const result = await api.post<ValidationResult>("/api/v1/validate", { definition: candidate });
      setValidation(result);
      syncCanvas(candidate, result);
    } catch (caught) {
      setError(caught as ClientError);
    }
  }, [syncCanvas]);

  useEffect(() => {
    void validateNow(initialDefinition);
    // Intentionally runs once: the initial definition is validated on mount.
  }, []);

  const update = useCallback((next: WorkflowDefinition) => {
    setDefinition(next);
    setDirty(true);
    syncCanvas(next, validation);
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => void validateNow(next), 400);
  }, [syncCanvas, validateNow, validation]);

  const addNode = useCallback((nodeType: string, at?: { x: number; y: number }) => {
    const registry = getNodeType(nodeType);
    if (!registry) return;
    const base = nodeType.split(".")[0] ?? "node";
    let suffix = 1;
    let id = base;
    while (definition.nodes.some((node) => node.id === id)) id = `${base}_${++suffix}`;

    const position = at ?? { x: 80 + definition.nodes.length * 40, y: 80 + definition.nodes.length * 30 };
    const config = Object.fromEntries(
      registry.fields.filter((field) => field.default !== undefined).map((field) => [field.name, field.default]),
    );
    update({
      ...definition,
      nodes: [...definition.nodes, { id, type: nodeType, config: config as WorkflowNode["config"], metadata: { position } }],
    });
    setSelectedId(id);
    setPaletteOpen(false);
  }, [definition, update]);

  const patchNode = useCallback((nodeId: string, patch: Partial<WorkflowNode>) => {
    const renaming = patch.id && patch.id !== nodeId;
    update({
      ...definition,
      nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      edges: renaming
        ? definition.edges.map((edge) => ({
            ...edge,
            from: edge.from === nodeId ? patch.id! : edge.from,
            to: edge.to === nodeId ? patch.id! : edge.to,
          }))
        : definition.edges,
    });
    if (renaming) setSelectedId(patch.id!);
  }, [definition, update]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    update({
      ...definition,
      nodes: definition.nodes.filter((node) => node.id !== selectedId),
      edges: definition.edges.filter((edge) => edge.from !== selectedId && edge.to !== selectedId),
    });
    setSelectedId(null);
  }, [definition, selectedId, update]);

  const duplicateSelected = useCallback(() => {
    const source = definition.nodes.find((node) => node.id === selectedId);
    if (!source) return;
    let suffix = 1;
    let id = `${source.id}_copy`;
    while (definition.nodes.some((node) => node.id === id)) id = `${source.id}_copy_${++suffix}`;
    const position = (source.metadata?.["position"] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    update({
      ...definition,
      nodes: [...definition.nodes, {
        ...structuredClone(source),
        id,
        metadata: { ...(source.metadata ?? {}), position: { x: position.x + 40, y: position.y + 60 } },
      }],
    });
    setSelectedId(id);
  }, [definition, selectedId, update]);

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setEdges((current) => addEdge(connection, current));
    update({
      ...definition,
      edges: [
        ...definition.edges,
        {
          from: connection.source,
          to: connection.target,
          ...(connection.sourceHandle && connection.sourceHandle !== "default" ? { port: connection.sourceHandle } : {}),
        },
      ],
    });
  }, [definition, setEdges, update]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // Persist positions so the canvas survives a reload.
      const positioned: WorkflowDefinition = {
        ...definition,
        nodes: definition.nodes.map((node) => {
          const flow = nodes.find((candidate) => candidate.id === node.id);
          return flow ? { ...node, metadata: { ...(node.metadata ?? {}), position: flow.position } } : node;
        }),
      };
      await api.patch(`/api/v1/pipelines/${pipelineId}`, { definition: positioned });
      setDefinition(positioned);
      setDirty(false);
      router.refresh();
    } catch (caught) {
      setError(caught as ClientError);
    } finally {
      setSaving(false);
    }
  }, [definition, nodes, pipelineId, router]);

  const publish = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (dirty) await save();
      await api.post(`/api/v1/pipelines/${pipelineId}/publish`, {});
      router.push(`/pipelines/${pipelineId}`);
    } catch (caught) {
      setError(caught as ClientError);
    } finally {
      setSaving(false);
    }
  }, [dirty, pipelineId, router, save]);

  const runPipeline = useCallback(async () => {
    setSaving(true);
    try {
      if (dirty) await save();
      const run = await api.post<{ id: string }>(`/api/v1/pipelines/${pipelineId}/run`, { useDraft: versionStatus === "draft" });
      router.push(`/runs/${run.id}`);
    } catch (caught) {
      setError(caught as ClientError);
    } finally {
      setSaving(false);
    }
  }, [dirty, pipelineId, router, save, versionStatus]);

  const previewSelected = useCallback(async () => {
    const node = definition.nodes.find((candidate) => candidate.id === selectedId);
    if (!node) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api.post<PreviewState>("/api/v1/preview/source", { nodeType: node.type, config: node.config ?? {}, limit: 50 }));
    } catch (caught) {
      setError(caught as ClientError);
    } finally {
      setPreviewing(false);
    }
  }, [definition.nodes, selectedId]);

  // Keyboard shortcuts: a tool people live in should not need the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (target?.closest(".monaco-editor")) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (event.key === "Backspace" || event.key === "Delete") { if (selectedId && canEdit) { event.preventDefault(); deleteSelected(); } }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") { if (selectedId && canEdit) { event.preventDefault(); duplicateSelected(); } }
      else if (event.key === "n" && canEdit) { event.preventDefault(); setPaletteOpen(true); }
      else if (event.key === "f") { event.preventDefault(); fitView({ duration: 200, padding: 0.2 }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, deleteSelected, duplicateSelected, fitView, save, selectedId]);

  const selectedNode = definition.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedDefinition = selectedNode ? getNodeType(selectedNode.type) : null;
  const upstreamOf = useMemo(() => {
    if (!selectedId) return [];
    return definition.edges.filter((edge) => edge.to === selectedId).map((edge) => edge.from);
  }, [definition.edges, selectedId]);

  const nodeIssues = useMemo(() => [
    ...(validation?.errors ?? []).filter((issue) => issue.nodeId === selectedId).map((issue) => ({ ...issue, severity: "error" as const })),
    ...(validation?.warnings ?? []).filter((issue) => issue.nodeId === selectedId).map((issue) => ({ ...issue, severity: "warning" as const })),
  ], [selectedId, validation]);

  const blockingErrors = validation?.errors ?? [];

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[13.5px] font-semibold">{pipelineName}</h1>
            <Badge tone={versionStatus === "published" ? "success" : "accent"} mono>v{versionNumber} {versionStatus}</Badge>
            {dirty && <Badge tone="warning">unsaved</Badge>}
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">
            {definition.nodes.length} nodes · {definition.edges.length} edges
            {validation && (validation.valid
              ? <span className="ml-1.5 text-[var(--color-success)]">valid</span>
              : <span className="ml-1.5 text-[var(--color-danger)]">{blockingErrors.length} error{blockingErrors.length === 1 ? "" : "s"}</span>)}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => setPaletteOpen(true)} disabled={!canEdit}>
            <Plus className="size-3.5" aria-hidden /> Add node <KeyHint>n</KeyHint>
          </Button>
          <Button size="sm" onClick={duplicateSelected} disabled={!canEdit || !selectedId}><Copy className="size-3.5" aria-hidden /></Button>
          <Button size="sm" variant="danger" onClick={deleteSelected} disabled={!canEdit || !selectedId}><Trash2 className="size-3.5" aria-hidden /></Button>
          <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />
          <Button size="sm" loading={saving} onClick={() => void save()} disabled={!canEdit || !dirty}>
            <Save className="size-3.5" aria-hidden /> Save draft
          </Button>
          <Button size="sm" onClick={() => void runPipeline()} disabled={!canRun || !validation?.valid} title={validation?.valid ? "" : "Fix validation errors first"}>
            <Play className="size-3.5" aria-hidden /> Run
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={() => void publish()} disabled={!canPublish || !validation?.valid}>
            <Upload className="size-3.5" aria-hidden /> Publish
          </Button>
        </div>
      </div>

      {(error || (validation && !validation.valid)) && (
        <div className="space-y-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          {error && (
            <Banner tone="danger" title={error.message}>
              {issuesOf(error).map((issue, index) => <div key={index}>{issue.message}</div>)}
            </Banner>
          )}
          {validation && !validation.valid && (
            <Banner tone="danger" title="Pipeline cannot run">
              <ul className="mt-1 space-y-1">
                {blockingErrors.slice(0, 6).map((issue, index) => (
                  <li key={index}>
                    {issue.nodeId && (
                      <button className="mono mr-1 underline" onClick={() => setSelectedId(issue.nodeId!)}>[{issue.nodeId}]</button>
                    )}
                    {issue.message}
                    {issue.hint && <span className="block text-[11px] text-[var(--color-text-subtle)]">{issue.hint}</span>}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {definition.nodes.length === 0 ? (
            <div className="grid h-full place-items-center">
              <EmptyState
                title="Empty canvas"
                description="Add a source to read data, one or more transforms, a quality check, and a destination to write the result."
                icon={<WandSparkles className="size-6" />}
                action={<Button variant="primary" onClick={() => setPaletteOpen(true)}>Add your first node</Button>}
              />
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={canEdit ? onNodesChange : undefined}
              onEdgesChange={canEdit ? onEdgesChange : undefined}
              onConnect={canEdit ? onConnect : undefined}
              onNodeClick={(_event, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              onNodeDragStop={(_event, node) => {
                patchNode(node.id, { metadata: { ...(definition.nodes.find((n) => n.id === node.id)?.metadata ?? {}), position: node.position } });
              }}
              onEdgesDelete={(deleted) => {
                update({
                  ...definition,
                  edges: definition.edges.filter((edge) => !deleted.some((candidate) => candidate.source === edge.from && candidate.target === edge.to)),
                });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const nodeType = event.dataTransfer.getData("application/dataflow-node-type");
                if (!nodeType) return;
                addNode(nodeType, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
              }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              fitView
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={null}
              multiSelectionKeyCode="Shift"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-border)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" className="!h-24 !w-40" nodeColor="var(--color-border-strong)" maskColor="transparent" />
            </ReactFlow>
          )}
        </div>

        <aside className="hidden w-[340px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] lg:block">
          {selectedNode && selectedDefinition ? (
            <ConfigPanel
              node={selectedNode}
              definition={selectedDefinition}
              secrets={secrets}
              connections={connections}
              upstreamNodeIds={upstreamOf}
              issues={nodeIssues}
              onChange={(patch) => patchNode(selectedNode.id, patch)}
              onPreview={() => void previewSelected()}
              previewDisabled={previewing}
            />
          ) : (
            <div className="p-4 text-[12.5px] text-[var(--color-text-muted)]">
              <h3 className="text-[13px] font-semibold text-[var(--color-text)]">No node selected</h3>
              <p className="mt-1">Select a node to configure it, or add one from the palette.</p>
              <dl className="mt-4 space-y-1.5 text-[11.5px]">
                {[["n", "add node"], ["⌘S", "save draft"], ["⌘D", "duplicate"], ["⌫", "delete"], ["f", "fit view"], ["shift+drag", "multi-select"]].map(([key, action]) => (
                  <div key={key} className="flex items-center gap-2">
                    <KeyHint>{key}</KeyHint>
                    <span>{action}</span>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </aside>
      </div>

      <NodePalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onSelect={(nodeType) => addNode(nodeType)} />

      <Dialog
        open={preview !== null || previewing}
        onClose={() => setPreview(null)}
        title="Data preview"
        description={preview ? `${preview.rowCount} rows read in ${preview.durationMs}ms${preview.truncated ? " (truncated)" : ""}` : "Reading a sample…"}
        wide
      >
        {previewing && <div className="flex items-center gap-2 py-6 text-[12.5px]"><Spinner /> Reading from the source…</div>}
        {preview && (
          <div className="space-y-3">
            <Table>
              <thead>
                <tr>
                  <Th>Column</Th><Th>Type</Th><Th align="right">Nulls</Th><Th align="right">Distinct</Th>
                </tr>
              </thead>
              <tbody>
                {preview.profile.map((column) => (
                  <tr key={column.name}>
                    <Td><span className="mono">{column.name}</span></Td>
                    <Td><Badge mono>{column.type}{column.nullable ? " ·null" : ""}</Badge></Td>
                    <Td align="right"><span className="mono">{column.nullCount}</span></Td>
                    <Td align="right"><span className="mono">{column.uniqueCount}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="max-h-64 overflow-auto rounded border border-[var(--color-border)]">
              <Table>
                <thead>
                  <tr>{preview.profile.map((column) => <Th key={column.name}>{column.name}</Th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 25).map((row, index) => (
                    <tr key={index}>
                      {preview.profile.map((column) => (
                        <Td key={column.name}>
                          <span className="mono">{formatCell(row[column.name])}</span>
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function NodePalette({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (nodeType: string) => void }) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => listNodeTypes(), []);
  const filtered = all.filter((entry) =>
    !query || entry.type.includes(query.toLowerCase()) || entry.label.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Dialog open={open} onClose={onClose} title="Add a node" description="Drag onto the canvas, or click to add." wide>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter node types…"
        aria-label="Filter node types"
        className="mb-3 h-8 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 text-[13px] focus:border-[var(--color-accent)] focus:outline-none"
      />
      <div className="max-h-[50vh] space-y-4 overflow-y-auto">
        {KIND_GROUPS.map((group) => {
          const entries = filtered.filter((entry) => group.kinds.includes(entry.kind));
          if (!entries.length) return null;
          return (
            <div key={group.label}>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">{group.label}</h4>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {entries.map((entry) => (
                  <button
                    key={entry.type}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/dataflow-node-type", entry.type);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onSelect(entry.type)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-2 text-left transition-colors hover:border-[var(--color-accent)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium">{entry.label}</span>
                      {entry.destructive && <Badge tone="danger">writes</Badge>}
                    </div>
                    <div className="mono mt-0.5 text-[10.5px] text-[var(--color-text-subtle)]">{entry.type}</div>
                    <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">{entry.description}</p>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!filtered.length && <p className="py-6 text-center text-[12.5px] text-[var(--color-text-subtle)]">No node type matches “{query}”.</p>}
      </div>
    </Dialog>
  );
}
