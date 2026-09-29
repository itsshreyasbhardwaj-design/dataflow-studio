"use client";

import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Banner, Card, CardHeader, Select } from "./ui";

export interface LineageProps {
  graph: {
    nodes: Array<{ id: string; type: "dataset" | "node"; label: string; nodeType?: string; pipelineId?: string; pipelineName?: string }>;
    edges: Array<{ from: string; fromType: string; to: string; toType: string; transformation?: string; pipelineId?: string }>;
    unresolved: Array<{ nodeId: string; nodeType: string; reason: string }>;
  };
  pipelines: Array<{ id: string; name: string }>;
  selectedPipelineId?: string;
}

/**
 * Lineage explorer.
 *
 * Datasets are the anchors; pipeline nodes sit between them. Anything the system
 * could not determine is listed under the graph rather than being drawn as a
 * guess, because a lineage diagram that quietly invents an edge is worse than one
 * that admits a gap.
 */
export function LineageGraphView({ graph, pipelines, selectedPipelineId }: LineageProps) {
  const [focus, setFocus] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const depth = new Map<string, number>();
    const upstream = new Map<string, string[]>();
    const key = (type: string, id: string): string => `${type}:${id}`;

    for (const node of graph.nodes) upstream.set(key(node.type, node.id), []);
    for (const edge of graph.edges) upstream.get(key(edge.toType, edge.to))?.push(key(edge.fromType, edge.from));

    const resolve = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = upstream.get(id) ?? [];
      const value = parents.length ? Math.max(...parents.map((parent) => resolve(parent, seen) + 1)) : 0;
      depth.set(id, value);
      return value;
    };
    for (const node of graph.nodes) resolve(key(node.type, node.id));

    const perLayer = new Map<number, number>();
    const flowNodes: Node[] = graph.nodes.map((node) => {
      const nodeKey = key(node.type, node.id);
      const layer = depth.get(nodeKey) ?? 0;
      const index = perLayer.get(layer) ?? 0;
      perLayer.set(layer, index + 1);
      const dimmed = focus !== null && focus !== nodeKey;

      return {
        id: nodeKey,
        position: { x: layer * 230, y: index * 92 },
        data: { label: node.label },
        style: {
          opacity: dimmed ? 0.45 : 1,
          fontSize: 11.5,
          padding: "6px 9px",
          borderRadius: 4,
          width: 180,
          border: `1px solid ${node.type === "dataset" ? "color-mix(in oklch, var(--color-info) 55%, transparent)" : "var(--color-border)"}`,
          background: node.type === "dataset" ? "color-mix(in oklch, var(--color-info) 10%, var(--color-surface))" : "var(--color-surface)",
          color: "var(--color-text)",
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });

    const flowEdges: Edge[] = graph.edges.map((edge) => ({
      id: `${edge.fromType}:${edge.from}->${edge.toType}:${edge.to}`,
      source: key(edge.fromType, edge.from),
      target: key(edge.toType, edge.to),
      ...(edge.transformation ? { label: edge.transformation } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      labelStyle: { fontSize: 9.5, fill: "var(--color-text-subtle)" },
      labelBgStyle: { fill: "var(--color-surface)" },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [focus, graph]);

  const datasets = graph.nodes.filter((node) => node.type === "dataset");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form action="/lineage" className="flex items-center gap-2">
          <Select name="pipelineId" defaultValue={selectedPipelineId ?? ""} className="w-56" aria-label="Filter by pipeline">
            <option value="">All pipelines</option>
            {pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
          </Select>
          <button type="submit" className="h-8 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-3 text-[13px]">
            Apply
          </button>
        </form>
        <Select value={focus ?? ""} onChange={(event) => setFocus(event.target.value || null)} className="w-56" aria-label="Focus a dataset">
          <option value="">Highlight nothing</option>
          {datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>{dataset.id}</option>)}
        </Select>
        <span className="text-[11.5px] text-[var(--color-text-subtle)]">
          {datasets.length} datasets · {graph.edges.length} edges
        </span>
      </div>

      <Card className="h-[520px] overflow-hidden">
        {graph.nodes.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <h3 className="text-[14px] font-semibold">No lineage recorded yet</h3>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-[var(--color-text-muted)]">
                Lineage is derived from published pipeline definitions. Publish a pipeline whose source and
                destination nodes name a dataset, and the graph appears here.
              </p>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-border)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        )}
      </Card>

      {graph.unresolved.length > 0 && (
        <Banner tone="warning" title={`${graph.unresolved.length} node(s) have unresolved lineage`}>
          <ul className="mt-1 space-y-0.5">
            {graph.unresolved.slice(0, 8).map((entry, index) => (
              <li key={index}>
                <span className="mono">{entry.nodeId}</span> ({entry.nodeType}): {entry.reason}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {datasets.length > 0 && (
        <Card>
          <CardHeader title="Datasets in this graph" />
          <ul className="grid gap-x-6 gap-y-1 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {datasets.map((dataset) => (
              <li key={dataset.id} className="flex items-center gap-2">
                <Badge tone="info" mono>dataset</Badge>
                <Link href={`/datasets/${encodeURIComponent(dataset.id)}`} className="mono truncate text-[12px] hover:text-[var(--color-accent)]">
                  {dataset.id}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
