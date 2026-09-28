import {
  buildIndex, getNodeType, type WorkflowDefinition, type WorkflowNode,
} from "@dataflow-studio/workflow-engine";
import type { LineageEdge, LineageGraph, LineageNode } from "./types.js";

/** The dataset a node reads from or writes to, when it declares one. */
export function datasetOf(node: WorkflowNode): string | null {
  const dataset = node.config?.["dataset"];
  if (typeof dataset === "string" && dataset) return dataset;
  // Relational and object-storage nodes name their target directly.
  const table = node.config?.["table"];
  if (typeof table === "string" && table) return table;
  const key = node.config?.["key"];
  if (typeof key === "string" && key) return key;
  return null;
}

/**
 * Derives a lineage graph from a workflow definition.
 *
 * Lineage is only asserted where the definition actually says something: a source
 * or destination that names a dataset produces a dataset node; a transform that
 * names one produces an intermediate dataset. Nodes that name nothing are
 * reported in `unresolved` rather than being connected by guesswork - claiming
 * lineage we cannot support is worse than admitting the gap.
 */
export function buildLineage(
  workflow: WorkflowDefinition,
  context: { pipelineId?: string; pipelineName?: string; pipelineVersionId?: string } = {},
): LineageGraph {
  const index = buildIndex(workflow);
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const unresolved: LineageGraph["unresolved"] = [];
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));

  const addDataset = (name: string, producedBy?: WorkflowNode): void => {
    if (!nodes.has(`dataset:${name}`)) {
      nodes.set(`dataset:${name}`, {
        id: name,
        type: "dataset",
        label: name,
        ...(producedBy ? { nodeType: producedBy.type } : {}),
        ...(context.pipelineId ? { pipelineId: context.pipelineId } : {}),
        ...(context.pipelineName ? { pipelineName: context.pipelineName } : {}),
      });
    }
  };

  const addEdge = (edge: LineageEdge): void => {
    const key = `${edge.fromType}:${edge.from}->${edge.toType}:${edge.to}`;
    if (edges.some((e) => `${e.fromType}:${e.from}->${e.toType}:${e.to}` === key)) return;
    edges.push({
      ...edge,
      ...(context.pipelineId ? { pipelineId: context.pipelineId } : {}),
      ...(context.pipelineVersionId ? { pipelineVersionId: context.pipelineVersionId } : {}),
    });
  };

  for (const node of workflow.nodes) {
    const definition = getNodeType(node.type);
    nodes.set(`node:${node.id}`, {
      id: node.id,
      type: "node",
      label: (node.metadata?.label as string | undefined) ?? node.id,
      nodeType: node.type,
      ...(context.pipelineId ? { pipelineId: context.pipelineId } : {}),
      ...(context.pipelineName ? { pipelineName: context.pipelineName } : {}),
    });

    const dataset = datasetOf(node);
    const kind = definition?.kind;

    if (kind === "source") {
      if (dataset) {
        addDataset(dataset, node);
        addEdge({ from: dataset, fromType: "dataset", to: node.id, toType: "node", nodeId: node.id });
      } else {
        unresolved.push({ nodeId: node.id, nodeType: node.type, reason: "Source does not name a dataset, so its upstream origin is unknown" });
      }
    }

    if (kind === "destination") {
      if (dataset) {
        addDataset(dataset, node);
        addEdge({ from: node.id, fromType: "node", to: dataset, toType: "dataset", nodeId: node.id, transformation: node.type });
      } else {
        unresolved.push({ nodeId: node.id, nodeType: node.type, reason: "Destination does not name a dataset, so its downstream target is unknown" });
      }
    }

    // A transform that names a dataset publishes an intermediate dataset.
    if (kind && !["source", "destination"].includes(kind) && dataset && definition?.producesDataset) {
      addDataset(dataset, node);
      addEdge({ from: node.id, fromType: "node", to: dataset, toType: "dataset", nodeId: node.id, transformation: node.type });
    }
  }

  // Node-to-node edges follow the DAG itself.
  for (const edge of index.edges) {
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    if (!fromNode || !toNode) continue;
    const fromDataset = datasetOf(fromNode);
    const fromDefinition = getNodeType(fromNode.type);
    if (fromDataset && fromDefinition?.producesDataset && fromDefinition.kind !== "source") {
      // Route through the dataset the upstream node published.
      addEdge({ from: fromDataset, fromType: "dataset", to: edge.to, toType: "node", nodeId: edge.to });
    } else {
      addEdge({ from: edge.from, fromType: "node", to: edge.to, toType: "node", nodeId: edge.to, transformation: toNode.type });
    }
  }

  return { nodes: [...nodes.values()], edges, unresolved };
}

export interface TraversalResult {
  upstream: LineageNode[];
  downstream: LineageNode[];
}

/** Walks the lineage graph in both directions from one node or dataset. */
export function traverse(graph: LineageGraph, startId: string, type: "dataset" | "node" = "dataset"): TraversalResult {
  const byKey = new Map(graph.nodes.map((n) => [`${n.type}:${n.id}`, n]));
  const walk = (direction: "up" | "down"): LineageNode[] => {
    const seen = new Set<string>([`${type}:${startId}`]);
    const out: LineageNode[] = [];
    const stack = [`${type}:${startId}`];
    while (stack.length) {
      const current = stack.pop()!;
      for (const edge of graph.edges) {
        const fromKey = `${edge.fromType}:${edge.from}`;
        const toKey = `${edge.toType}:${edge.to}`;
        const [source, target] = direction === "up" ? [toKey, fromKey] : [fromKey, toKey];
        if (source !== current || seen.has(target)) continue;
        seen.add(target);
        const node = byKey.get(target);
        if (node) out.push(node);
        stack.push(target);
      }
    }
    return out;
  };
  return { upstream: walk("up"), downstream: walk("down") };
}

/** Merges per-pipeline graphs into the organization-wide lineage view. */
export function mergeGraphs(graphs: readonly LineageGraph[]): LineageGraph {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const unresolved: LineageGraph["unresolved"] = [];
  const edgeKeys = new Set<string>();

  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const key = `${node.type}:${node.id}`;
      // Datasets are shared across pipelines; keep the first producer we saw.
      if (!nodes.has(key)) nodes.set(key, node);
    }
    for (const edge of graph.edges) {
      const key = `${edge.fromType}:${edge.from}->${edge.toType}:${edge.to}:${edge.pipelineId ?? ""}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
    unresolved.push(...graph.unresolved);
  }
  return { nodes: [...nodes.values()], edges, unresolved };
}
