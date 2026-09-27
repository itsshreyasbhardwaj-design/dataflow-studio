import { buildIndex, findCycles, isolatedNodes, weaklyConnectedComponents, type AdjacencyIndex } from "./dag.js";
import { getNodeType } from "./node-types.js";
import { applyDefaults, collectSecretRefs, validateConfig } from "./schema.js";
import {
  isSecretReference,
  type NodeConfig,
  type WorkflowDefinition,
  type WorkflowEdge,
} from "./types.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationCode =
  | "workflow.name_invalid"
  | "workflow.empty"
  | "workflow.too_large"
  | "node.id_invalid"
  | "node.id_duplicate"
  | "node.type_unknown"
  | "node.type_unsupported"
  | "node.config_invalid"
  | "node.timeout_invalid"
  | "node.retry_invalid"
  | "node.missing_input"
  | "node.too_many_inputs"
  | "node.disconnected"
  | "node.destructive_retry"
  | "edge.node_missing"
  | "edge.port_unknown"
  | "edge.self_loop"
  | "graph.cycle"
  | "graph.fragmented"
  | "graph.no_source"
  | "graph.no_destination"
  | "dependency.unresolved"
  | "dependency.not_upstream"
  | "credential.connection_missing"
  | "credential.secret_missing"
  | "quality.gate_without_check"
  | "schema.contract_invalid";

export interface ValidationIssue {
  code: ValidationCode;
  severity: ValidationSeverity;
  message: string;
  /** Anchors the issue to a node so the editor can highlight it. */
  nodeId?: string;
  edge?: WorkflowEdge;
  field?: string;
  hint?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Config with registry defaults applied - what the executor will actually see. */
  normalized?: WorkflowDefinition;
}

export interface ValidationContext {
  /** Connector records the caller is allowed to use: id -> family. */
  connections?: Record<string, string>;
  /** Secret names visible to the caller. */
  secrets?: readonly string[];
  /** Connector families this deployment supports. */
  enabledConnectorFamilies?: readonly string[];
  limits?: { maxNodes?: number; maxEdges?: number; maxTimeoutSeconds?: number };
}

const NODE_ID = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const DEFAULT_LIMITS = { maxNodes: 500, maxEdges: 2000, maxTimeoutSeconds: 86_400 };

export function validateWorkflow(
  workflow: WorkflowDefinition,
  context: ValidationContext = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const limits = { ...DEFAULT_LIMITS, ...context.limits };
  const push = (issue: ValidationIssue): void => void issues.push(issue);

  // ---------------------------------------------------------------- workflow
  if (!WORKFLOW_NAME.test(workflow.name ?? "")) {
    push({
      code: "workflow.name_invalid",
      severity: "error",
      message: `Pipeline name "${workflow.name}" must be lowercase alphanumeric with dashes or underscores (2-64 chars)`,
      field: "name",
    });
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    push({ code: "workflow.empty", severity: "error", message: "Pipeline has no nodes" });
    return finish(issues);
  }
  if (workflow.nodes.length > limits.maxNodes) {
    push({
      code: "workflow.too_large",
      severity: "error",
      message: `Pipeline has ${workflow.nodes.length} nodes, which exceeds the limit of ${limits.maxNodes}`,
    });
  }
  if ((workflow.edges?.length ?? 0) > limits.maxEdges) {
    push({
      code: "workflow.too_large",
      severity: "error",
      message: `Pipeline has ${workflow.edges.length} edges, which exceeds the limit of ${limits.maxEdges}`,
    });
  }

  // ------------------------------------------------------------------- nodes
  const seenIds = new Set<string>();
  const normalizedNodes = workflow.nodes.map((node) => {
    if (!NODE_ID.test(node.id ?? "")) {
      push({
        code: "node.id_invalid",
        severity: "error",
        message: `Node ID "${node.id}" is invalid: use letters, digits, dash or underscore and start with a letter`,
        nodeId: node.id,
      });
    }
    if (seenIds.has(node.id)) {
      push({
        code: "node.id_duplicate",
        severity: "error",
        message: `Duplicate node ID "${node.id}"`,
        nodeId: node.id,
        hint: "Node IDs address task state and logs; they must be unique within a version.",
      });
    }
    seenIds.add(node.id);

    const definition = getNodeType(node.type);
    if (!definition) {
      push({
        code: "node.type_unknown",
        severity: "error",
        message: `Node "${node.id}" uses unknown type "${node.type}"`,
        nodeId: node.id,
        hint: "Node types are registered by the worker fleet. Check for a typo or an unreleased connector.",
      });
      return node;
    }

    if (
      definition.connectorFamily &&
      context.enabledConnectorFamilies &&
      !context.enabledConnectorFamilies.includes(definition.connectorFamily)
    ) {
      push({
        code: "node.type_unsupported",
        severity: "error",
        message: `Connector family "${definition.connectorFamily}" is not enabled on this deployment`,
        nodeId: node.id,
      });
    }

    const config = applyDefaults(definition.fields, node.config ?? {});
    for (const issue of validateConfig(definition.fields, config)) {
      push({
        code: "node.config_invalid",
        severity: "error",
        message: `Node "${node.id}": ${issue.message}`,
        nodeId: node.id,
        field: issue.field,
      });
    }

    if (node.timeoutSeconds !== undefined) {
      if (!Number.isInteger(node.timeoutSeconds) || node.timeoutSeconds <= 0 || node.timeoutSeconds > limits.maxTimeoutSeconds) {
        push({
          code: "node.timeout_invalid",
          severity: "error",
          message: `Node "${node.id}" timeout must be between 1 and ${limits.maxTimeoutSeconds} seconds`,
          nodeId: node.id,
          field: "timeoutSeconds",
        });
      }
    }

    const retry = node.retry ?? workflow.defaults?.retry;
    if (retry) {
      if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 25) {
        push({
          code: "node.retry_invalid",
          severity: "error",
          message: `Node "${node.id}" retry.maxAttempts must be an integer between 1 and 25`,
          nodeId: node.id,
          field: "retry.maxAttempts",
        });
      }
      if (retry.strategy === "explicit" && (retry.delaysSeconds?.length ?? 0) < retry.maxAttempts - 1) {
        push({
          code: "node.retry_invalid",
          severity: "error",
          message: `Node "${node.id}" uses explicit backoff but declares fewer delays than retries`,
          nodeId: node.id,
          field: "retry.delaysSeconds",
        });
      }
      if (definition.destructive && retry.maxAttempts > 1 && config["idempotent"] !== true) {
        push({
          code: "node.destructive_retry",
          severity: "warning",
          message: `Node "${node.id}" writes to an external system and is configured to retry, but is not marked idempotent`,
          nodeId: node.id,
          hint: 'Set `idempotent: true` only if a repeated write is safe. Otherwise the executor will refuse the retry at runtime.',
        });
      }
    }

    // Credentials -----------------------------------------------------------
    const connectionId = config["connectionId"];
    if (definition.connectorFamily && definition.connectorFamily !== "file" && typeof connectionId === "string" && context.connections) {
      const family = context.connections[connectionId];
      if (!family) {
        push({
          code: "credential.connection_missing",
          severity: "error",
          message: `Node "${node.id}" references connection "${connectionId}", which does not exist or is not visible to you`,
          nodeId: node.id,
          field: "connectionId",
        });
      } else if (family !== definition.connectorFamily) {
        push({
          code: "credential.connection_missing",
          severity: "error",
          message: `Node "${node.id}" expects a ${definition.connectorFamily} connection but "${connectionId}" is ${family}`,
          nodeId: node.id,
          field: "connectionId",
        });
      }
    }

    if (context.secrets) {
      for (const ref of collectSecretRefs(config)) {
        if (!context.secrets.includes(ref)) {
          push({
            code: "credential.secret_missing",
            severity: "error",
            message: `Node "${node.id}" references secret "${ref}", which does not exist or is not readable by you`,
            nodeId: node.id,
          });
        }
      }
    }

    if (node.type === "schema.validate") {
      const expected = config["expected"];
      if (expected !== undefined && !Array.isArray(expected)) {
        push({
          code: "schema.contract_invalid",
          severity: "error",
          message: `Node "${node.id}": expected columns must be an array`,
          nodeId: node.id,
          field: "expected",
        });
      }
    }

    return { ...node, config };
  });

  const nodeById = new Map(normalizedNodes.map((n) => [n.id, n]));

  // ------------------------------------------------------------------- edges
  for (const edge of workflow.edges ?? []) {
    if (!nodeById.has(edge.from)) {
      push({
        code: "edge.node_missing",
        severity: "error",
        message: `Edge references unknown source node "${edge.from}"`,
        edge,
      });
    }
    if (!nodeById.has(edge.to)) {
      push({
        code: "edge.node_missing",
        severity: "error",
        message: `Edge references unknown target node "${edge.to}"`,
        edge,
      });
    }
    if (edge.from === edge.to) {
      push({
        code: "edge.self_loop",
        severity: "error",
        message: `Node "${edge.from}" cannot depend on itself`,
        nodeId: edge.from,
        edge,
      });
    }
    const fromNode = nodeById.get(edge.from);
    const definition = fromNode ? getNodeType(fromNode.type) : undefined;
    if (definition && edge.port && !definition.outputs.includes(edge.port)) {
      push({
        code: "edge.port_unknown",
        severity: "error",
        message: `Node "${edge.from}" has no output port "${edge.port}" (available: ${definition.outputs.join(", ")})`,
        nodeId: edge.from,
        edge,
      });
    }
  }

  // Bail out before graph analysis if the topology itself is unsound.
  if (issues.some((i) => i.severity === "error" && (i.code === "edge.node_missing" || i.code === "node.id_duplicate"))) {
    return finish(issues);
  }

  const normalized: WorkflowDefinition = { ...workflow, nodes: normalizedNodes };
  const index = buildIndex(normalized);

  // ------------------------------------------------------------------- graph
  for (const cycle of findCycles(index)) {
    push({
      code: "graph.cycle",
      severity: "error",
      message: `Cycle detected: ${[...cycle, cycle[0]].join(" -> ")}`,
      nodeId: cycle[0],
      hint: "Workflows must be acyclic. Break the loop or model the repetition as a schedule.",
    });
  }

  for (const node of normalizedNodes) {
    const definition = getNodeType(node.type);
    if (!definition) continue;
    const inbound = index.upstream.get(node.id) ?? [];
    if (inbound.length < definition.inputs.min) {
      push({
        code: "node.missing_input",
        severity: "error",
        message:
          definition.inputs.min === 1
            ? `Node "${node.id}" requires an input but has none connected`
            : `Node "${node.id}" requires ${definition.inputs.min} inputs but has ${inbound.length}`,
        nodeId: node.id,
        hint: `${definition.label} consumes data from upstream. Connect ${definition.inputs.min - inbound.length} more edge(s).`,
      });
    }
    if (inbound.length > definition.inputs.max) {
      push({
        code: "node.too_many_inputs",
        severity: "error",
        message: `Node "${node.id}" accepts at most ${definition.inputs.max} inputs but has ${inbound.length}`,
        nodeId: node.id,
      });
    }
  }

  for (const id of isolatedNodes(index)) {
    push({
      code: "node.disconnected",
      severity: "error",
      message: `Node "${id}" is not connected to anything and would never run`,
      nodeId: id,
    });
  }

  const components = weaklyConnectedComponents(index);
  if (components.length > 1 && normalizedNodes.length > 1) {
    const sizes = components.map((c) => c.length).join(", ");
    push({
      code: "graph.fragmented",
      severity: "warning",
      message: `Pipeline contains ${components.length} disconnected subgraphs (sizes: ${sizes})`,
      hint: "Independent subgraphs run concurrently in the same run. Split them into separate pipelines if that is not intended.",
    });
  }

  const hasSource = normalizedNodes.some((n) => getNodeType(n.type)?.kind === "source");
  if (!hasSource) {
    push({
      code: "graph.no_source",
      severity: "error",
      message: "Pipeline has no source node, so it has nothing to read",
    });
  }
  const hasDestination = normalizedNodes.some((n) => getNodeType(n.type)?.kind === "destination");
  if (!hasDestination) {
    push({
      code: "graph.no_destination",
      severity: "warning",
      message: "Pipeline has no destination node, so its results are not persisted anywhere",
    });
  }

  validateDependencies(normalized, index, push);

  return finish(issues, normalized);
}

/**
 * Checks the references nodes make to *other nodes* inside their own config -
 * join sides, SQL table aliases, quality gates. These are the failures that
 * used to surface only at 02:14 UTC.
 */
function validateDependencies(
  workflow: WorkflowDefinition,
  index: AdjacencyIndex,
  push: (issue: ValidationIssue) => void,
): void {
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));

  for (const node of workflow.nodes) {
    const upstream = index.upstream.get(node.id) ?? [];
    const config: NodeConfig = node.config ?? {};

    const requireUpstream = (ref: unknown, field: string): void => {
      if (typeof ref !== "string" || ref === "") return;
      if (!nodeById.has(ref)) {
        push({
          code: "dependency.unresolved",
          severity: "error",
          message: `Node "${node.id}" references "${ref}" in ${field}, which is not a node in this pipeline`,
          nodeId: node.id,
          field,
        });
        return;
      }
      if (!upstream.includes(ref)) {
        push({
          code: "dependency.not_upstream",
          severity: "error",
          message: `Node "${node.id}" requires input from "${ref}". The dependency is missing.`,
          nodeId: node.id,
          field,
          hint: `Connect "${ref}" to "${node.id}" with an edge, or point ${field} at one of: ${upstream.join(", ") || "(nothing connected)"}.`,
        });
      }
    };

    if (node.type === "join.transform") {
      requireUpstream(config["left"], "left");
      requireUpstream(config["right"], "right");
      if (config["left"] && config["left"] === config["right"]) {
        push({
          code: "dependency.unresolved",
          severity: "error",
          message: `Node "${node.id}" joins "${String(config["left"])}" to itself`,
          nodeId: node.id,
          field: "left",
        });
      }
      const on = config["on"];
      if (!Array.isArray(on) || on.length === 0) {
        push({
          code: "node.config_invalid",
          severity: "error",
          message: `Node "${node.id}" needs at least one join key pair`,
          nodeId: node.id,
          field: "on",
        });
      }
    }

    if (node.type === "sql.transform") {
      const aliases = config["aliases"];
      if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
        for (const [alias, target] of Object.entries(aliases)) {
          requireUpstream(target, `aliases.${alias}`);
        }
      }
      // `input` is the implicit alias for a single upstream node.
      const query = typeof config["query"] === "string" ? config["query"] : "";
      const aliasNames = new Set(Object.keys((aliases as Record<string, unknown>) ?? {}));
      const referenced = extractTableNames(query);
      for (const table of referenced) {
        if (aliasNames.has(table)) continue;
        if (nodeById.has(table) && upstream.includes(table)) continue;
        if (table === "input" && upstream.length >= 1) continue;
        push({
          code: "dependency.unresolved",
          severity: "error",
          message: `Node "${node.id}" queries table "${table}", which is neither an upstream node ID nor a declared alias`,
          nodeId: node.id,
          field: "query",
          hint: upstream.length === 1
            ? `Use "input" to reference the single upstream node "${upstream[0]}", or add an alias.`
            : `Available upstream nodes: ${upstream.join(", ") || "(none)"}.`,
        });
      }
    }

    if (node.type === "quality.gate") {
      const scope = config["scope"] ?? "upstream";
      if (scope === "upstream") {
        const ancestorTypes = collectAncestorTypes(index, nodeById, node.id);
        if (!ancestorTypes.has("quality.check")) {
          push({
            code: "quality.gate_without_check",
            severity: "error",
            message: `Quality gate "${node.id}" has no upstream quality check, so it can never evaluate anything`,
            nodeId: node.id,
            hint: "Add a `quality.check` node upstream of the gate, or set the gate scope to `run`.",
          });
        }
      }
    }
  }
}

function collectAncestorTypes(
  index: AdjacencyIndex,
  nodeById: Map<string, { type: string }>,
  nodeId: string,
): Set<string> {
  const types = new Set<string>();
  const stack = [...(index.upstream.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = nodeById.get(current);
    if (node) types.add(node.type);
    stack.push(...(index.upstream.get(current) ?? []));
  }
  return types;
}

/**
 * Extracts table identifiers from FROM / JOIN clauses. This is not a SQL parser -
 * it is a dependency sniffer whose only job is catching typos before execution.
 * The real parse happens in @dataflow-studio/transformations.
 */
export function extractTableNames(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const names = new Set<string>();
  const re = /\b(?:from|join)\s+("?[A-Za-z_][A-Za-z0-9_-]*"?)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const raw = match[1]!.replace(/"/g, "");
    if (!/^(select|lateral|unnest)$/i.test(raw)) names.add(raw);
  }
  return [...names];
}

function finish(issues: ValidationIssue[], normalized?: WorkflowDefinition): ValidationResult {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(normalized && errors.length === 0 ? { normalized } : {}),
  };
}

/** Human-readable rendering used by the CLI and the editor's error panel. */
export function formatValidationResult(result: ValidationResult, pipelineName?: string): string {
  if (result.valid && result.warnings.length === 0) {
    return `Pipeline${pipelineName ? ` "${pipelineName}"` : ""} is valid.`;
  }
  const lines: string[] = [];
  if (!result.valid) {
    lines.push("Pipeline cannot run", "");
  }
  for (const issue of result.errors) {
    lines.push(`Error${issue.nodeId ? ` [${issue.nodeId}]` : ""}: ${issue.message}`);
    if (issue.hint) lines.push(`  ${issue.hint}`);
  }
  if (result.errors.length && result.warnings.length) lines.push("");
  for (const issue of result.warnings) {
    lines.push(`Warning${issue.nodeId ? ` [${issue.nodeId}]` : ""}: ${issue.message}`);
    if (issue.hint) lines.push(`  ${issue.hint}`);
  }
  return lines.join("\n");
}

export function assertSecretsNotInlined(config: NodeConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (isSecretReference(value)) continue;
    if (typeof value === "string" && /password|secret|token|api[-_]?key/i.test(key)) {
      throw new Error(`Configuration key "${key}" must use a secret reference, not a literal value`);
    }
  }
}
