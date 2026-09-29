"use client";

import clsx from "clsx";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Braces, Check, Clock, Code2,
  Filter, GitMerge, Globe, Shield, ShieldCheck, Sigma, SplitSquareHorizontal, Table2, Webhook, X,
} from "lucide-react";

export interface DagNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  kind: string;
  /** Present on the run page. */
  state?: string;
  durationMs?: number | null;
  rowCount?: number | null;
  errorCount?: number;
  /** Validation issues anchored to this node. */
  issues?: Array<{ message: string; severity: "error" | "warning" }>;
  subtitle?: string;
}

const KIND_ICON: Record<string, typeof Table2> = {
  source: ArrowUpFromLine,
  destination: ArrowDownToLine,
  transform: Braces,
  sql: Table2,
  filter: Filter,
  aggregate: Sigma,
  join: GitMerge,
  validate: ShieldCheck,
  quality_gate: Shield,
  python: Code2,
  http: Globe,
  webhook: Webhook,
  delay: Clock,
  condition: SplitSquareHorizontal,
};

const STATE_BORDER: Record<string, string> = {
  SUCCESS: "border-[color-mix(in_oklch,var(--color-success)_55%,transparent)]",
  FAILED: "border-[color-mix(in_oklch,var(--color-danger)_60%,transparent)]",
  RUNNING: "border-[var(--color-accent)]",
  RETRYING: "border-[color-mix(in_oklch,var(--color-warning)_60%,transparent)]",
  BLOCKED: "border-[color-mix(in_oklch,var(--color-warning)_60%,transparent)]",
  CANCELLED: "border-[var(--color-border-strong)]",
  SKIPPED: "border-dashed border-[var(--color-border-strong)]",
};

/** One node on the canvas. Used by both the editor and the read-only run view. */
export function DagNode({ data, selected }: NodeProps) {
  const node = data as DagNodeData;
  const Icon = KIND_ICON[node.kind] ?? Braces;
  const hasError = node.issues?.some((issue) => issue.severity === "error") ?? false;
  const hasWarning = node.issues?.some((issue) => issue.severity === "warning") ?? false;
  const isCondition = node.kind === "condition";

  return (
    <div
      className={clsx(
        "w-[200px] rounded border bg-[var(--color-surface)] shadow-sm transition-colors",
        node.state ? STATE_BORDER[node.state] ?? "border-[var(--color-border)]" : "border-[var(--color-border)]",
        selected && "ring-1 ring-[var(--color-accent)]",
        hasError && "border-[color-mix(in_oklch,var(--color-danger)_70%,transparent)]",
        node.state === "RUNNING" && "running-pulse",
        node.state === "SKIPPED" && "opacity-60",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable />

      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5">
        <Icon className="size-3.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{node.label}</span>
        {node.state === "SUCCESS" && <Check className="size-3.5 text-[var(--color-success)]" aria-hidden />}
        {node.state === "FAILED" && <X className="size-3.5 text-[var(--color-danger)]" aria-hidden />}
        {node.state === "BLOCKED" && <Shield className="size-3.5 text-[var(--color-warning)]" aria-hidden />}
        {!node.state && hasError && <AlertTriangle className="size-3.5 text-[var(--color-danger)]" aria-hidden />}
        {!node.state && !hasError && hasWarning && <AlertTriangle className="size-3.5 text-[var(--color-warning)]" aria-hidden />}
      </div>

      <div className="px-2 py-1.5">
        <div className="mono truncate text-[10.5px] text-[var(--color-text-subtle)]">{node.nodeType}</div>
        {node.subtitle && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{node.subtitle}</div>}

        {(node.rowCount !== undefined && node.rowCount !== null) || node.durationMs ? (
          <div className="mt-1 flex items-center gap-2 mono text-[10.5px] text-[var(--color-text-muted)]">
            {node.rowCount !== undefined && node.rowCount !== null && <span>{node.rowCount.toLocaleString("en-US")} rows</span>}
            {node.durationMs ? <span>{node.durationMs < 1000 ? `${node.durationMs}ms` : `${(node.durationMs / 1000).toFixed(1)}s`}</span> : null}
          </div>
        ) : null}

        {node.issues?.length ? (
          <ul className="mt-1 space-y-0.5">
            {node.issues.slice(0, 2).map((issue, index) => (
              <li
                key={index}
                className={clsx("text-[10.5px] leading-snug", issue.severity === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-warning)]")}
              >
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {isCondition ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: "38%" }} isConnectable />
          <Handle id="false" type="source" position={Position.Right} style={{ top: "72%" }} isConnectable />
          <div className="pointer-events-none absolute -right-8 top-[30%] mono text-[9.5px] text-[var(--color-success)]">true</div>
          <div className="pointer-events-none absolute -right-9 top-[64%] mono text-[9.5px] text-[var(--color-text-subtle)]">false</div>
        </>
      ) : (
        <Handle type="source" position={Position.Right} isConnectable />
      )}
    </div>
  );
}

export const nodeTypes = { dataflow: DagNode };
