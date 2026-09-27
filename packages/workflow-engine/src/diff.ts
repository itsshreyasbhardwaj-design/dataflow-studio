import type { NodeConfig, WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./types.js";

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeChange {
  nodeId: string;
  type: string;
  /** Set when the node type itself changed. */
  previousType?: string;
  configChanges: ConfigChange[];
  retryChanged: boolean;
  timeoutChanged: boolean;
  /** Position-only moves are not semantic changes. */
  positionOnly: boolean;
}

export interface WorkflowDiff {
  addedNodes: WorkflowNode[];
  removedNodes: WorkflowNode[];
  changedNodes: NodeChange[];
  addedEdges: WorkflowEdge[];
  removedEdges: WorkflowEdge[];
  /** True when nothing that affects execution changed. */
  semanticallyEqual: boolean;
  summary: string[];
}

const edgeKey = (e: WorkflowEdge): string => `${e.from}->${e.to}:${e.port ?? "default"}`;

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out[prefix] = [];
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) out[prefix] = {};
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function diffConfig(before: NodeConfig, after: NodeConfig): ConfigChange[] {
  const a = flatten(before ?? {});
  const b = flatten(after ?? {});
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: ConfigChange[] = [];
  for (const key of [...keys].sort()) {
    const av = a[key];
    const bv = b[key];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      changes.push({ path: key, before: av, after: bv });
    }
  }
  return changes;
}

export function diffWorkflows(before: WorkflowDefinition, after: WorkflowDefinition): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));

  const changedNodes: NodeChange[] = [];
  for (const [id, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(id);
    if (!beforeNode) continue;
    const configChanges = diffConfig(beforeNode.config ?? {}, afterNode.config ?? {});
    const retryChanged = JSON.stringify(beforeNode.retry ?? null) !== JSON.stringify(afterNode.retry ?? null);
    const timeoutChanged = (beforeNode.timeoutSeconds ?? null) !== (afterNode.timeoutSeconds ?? null);
    const typeChanged = beforeNode.type !== afterNode.type;
    const positionChanged =
      JSON.stringify(beforeNode.metadata?.position ?? null) !== JSON.stringify(afterNode.metadata?.position ?? null);

    if (configChanges.length || retryChanged || timeoutChanged || typeChanged || positionChanged) {
      changedNodes.push({
        nodeId: id,
        type: afterNode.type,
        ...(typeChanged ? { previousType: beforeNode.type } : {}),
        configChanges,
        retryChanged,
        timeoutChanged,
        positionOnly: positionChanged && !configChanges.length && !retryChanged && !timeoutChanged && !typeChanged,
      });
    }
  }

  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const addedEdges = [...afterEdges].filter(([k]) => !beforeEdges.has(k)).map(([, e]) => e);
  const removedEdges = [...beforeEdges].filter(([k]) => !afterEdges.has(k)).map(([, e]) => e);

  const semanticChanges = changedNodes.filter((c) => !c.positionOnly);
  const semanticallyEqual =
    addedNodes.length === 0 &&
    removedNodes.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0 &&
    semanticChanges.length === 0 &&
    JSON.stringify(before.params ?? {}) === JSON.stringify(after.params ?? {}) &&
    JSON.stringify(before.defaults ?? {}) === JSON.stringify(after.defaults ?? {});

  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    semanticallyEqual,
    summary: summarize({ addedNodes, removedNodes, changedNodes: semanticChanges, addedEdges, removedEdges }, after),
  };
}

function summarize(
  diff: {
    addedNodes: WorkflowNode[];
    removedNodes: WorkflowNode[];
    changedNodes: NodeChange[];
    addedEdges: WorkflowEdge[];
    removedEdges: WorkflowEdge[];
  },
  after: WorkflowDefinition,
): string[] {
  const lines: string[] = [];
  if (diff.addedNodes.length) lines.push(`+ ${diff.addedNodes.length} node${diff.addedNodes.length === 1 ? "" : "s"}`);
  if (diff.removedNodes.length) lines.push(`- ${diff.removedNodes.length} node${diff.removedNodes.length === 1 ? "" : "s"}`);
  const configCount = diff.changedNodes.reduce((sum, c) => sum + c.configChanges.length, 0);
  if (configCount) lines.push(`~ ${configCount} configuration${configCount === 1 ? "" : "s"} changed`);
  if (diff.addedEdges.length) lines.push(`+ ${diff.addedEdges.length} edge${diff.addedEdges.length === 1 ? "" : "s"}`);
  if (diff.removedEdges.length) lines.push(`- ${diff.removedEdges.length} edge${diff.removedEdges.length === 1 ? "" : "s"}`);

  const addedQuality = diff.addedNodes.filter((n) => n.type === "quality.check" || n.type === "quality.gate");
  for (const node of addedQuality) {
    lines.push(`+ ${node.type === "quality.gate" ? "quality gate" : "quality check"} (${node.id})`);
  }
  const retryChanges = diff.changedNodes.filter((c) => c.retryChanged);
  if (retryChanges.length) lines.push(`~ retry policy on ${retryChanges.map((c) => c.nodeId).join(", ")}`);

  if (!lines.length) lines.push("No semantic changes");
  else lines.unshift(`${after.name} v${after.version}`);
  return lines;
}
