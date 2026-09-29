"use client";

import type { FieldSchema, NodeTypeDefinition, WorkflowNode } from "@dataflow-studio/workflow-engine";
import { Badge, Button, Field, Input, Select, Textarea } from "../ui";
import { CodeEditor } from "./code-editor";

export interface ConfigPanelProps {
  node: WorkflowNode;
  definition: NodeTypeDefinition;
  /** Secret names the user may reference. Values are never available here. */
  secrets: string[];
  connections: Array<{ id: string; name: string; family: string }>;
  upstreamNodeIds: string[];
  issues: Array<{ field?: string; message: string; severity: "error" | "warning" }>;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onPreview?: () => void;
  previewDisabled?: boolean;
}

function visible(field: FieldSchema, config: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  const actual = config[field.visibleWhen.field];
  return typeof actual === "string" && field.visibleWhen.equals.includes(actual);
}

/**
 * Renders a node's configuration form from the node-type registry.
 *
 * The form is generated from the same field schema the validator and the worker
 * use, so a field cannot exist in the UI and be unknown to the engine (or the
 * reverse). Adding a connector means adding one registry entry.
 */
export function ConfigPanel({
  node, definition, secrets, connections, upstreamNodeIds, issues, onChange, onPreview, previewDisabled,
}: ConfigPanelProps) {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const setConfig = (key: string, value: unknown): void => {
    onChange({ config: { ...config, [key]: value } as WorkflowNode["config"] });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-[13px] font-semibold">{definition.label}</h3>
          {definition.experimental && <Badge tone="warning">experimental</Badge>}
        </div>
        <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{definition.description}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Badge mono tone="neutral">{node.type}</Badge>
          {definition.destructive && <Badge tone="danger">writes data</Badge>}
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        <Field label="Node ID" htmlFor="node-id" hint="Addresses task state, logs and dependencies. Changing it starts a new history.">
          <Input
            id="node-id"
            className="mono"
            value={node.id}
            onChange={(event) => onChange({ id: event.target.value })}
            pattern="^[a-zA-Z_][a-zA-Z0-9_-]*$"
          />
        </Field>

        <Field label="Label" htmlFor="node-label" hint="Shown on the canvas and in run logs.">
          <Input
            id="node-label"
            value={(node.metadata?.["label"] as string | undefined) ?? ""}
            placeholder={node.id}
            onChange={(event) => onChange({ metadata: { ...(node.metadata ?? {}), label: event.target.value } })}
          />
        </Field>

        {definition.fields.filter((field) => visible(field, config)).map((field) => (
          <ConfigField
            key={field.name}
            field={field}
            value={config[field.name]}
            secrets={secrets}
            connections={connections.filter((connection) => !definition.connectorFamily || connection.family === definition.connectorFamily)}
            upstreamNodeIds={upstreamNodeIds}
            error={issues.find((issue) => issue.field === field.name)?.message}
            onChange={(value) => setConfig(field.name, value)}
          />
        ))}

        <details className="rounded border border-[var(--color-border)] px-2.5 py-2">
          <summary className="cursor-pointer text-[12px] font-medium text-[var(--color-text-muted)]">Retries and timeout</summary>
          <div className="mt-2 space-y-3">
            <Field label="Maximum attempts" htmlFor="retry-attempts" hint="1 disables retries. Destructive writes are only retried when marked idempotent.">
              <Input
                id="retry-attempts"
                type="number"
                min={1}
                max={25}
                value={node.retry?.maxAttempts ?? 3}
                onChange={(event) => onChange({
                  retry: {
                    strategy: node.retry?.strategy ?? "exponential",
                    initialDelaySeconds: node.retry?.initialDelaySeconds ?? 5,
                    multiplier: node.retry?.multiplier ?? 6,
                    maxAttempts: Number(event.target.value),
                  },
                })}
              />
            </Field>
            <Field label="Backoff" htmlFor="retry-strategy">
              <Select
                id="retry-strategy"
                value={node.retry?.strategy ?? "exponential"}
                onChange={(event) => onChange({
                  retry: {
                    maxAttempts: node.retry?.maxAttempts ?? 3,
                    initialDelaySeconds: node.retry?.initialDelaySeconds ?? 5,
                    multiplier: node.retry?.multiplier ?? 6,
                    strategy: event.target.value as "exponential" | "fixed",
                  },
                })}
              >
                <option value="exponential">Exponential</option>
                <option value="fixed">Fixed</option>
              </Select>
            </Field>
            <Field label="Timeout (seconds)" htmlFor="node-timeout" hint="A task that exceeds this is aborted and counted as a timeout failure.">
              <Input
                id="node-timeout"
                type="number"
                min={1}
                value={node.timeoutSeconds ?? ""}
                placeholder="none"
                onChange={(event) => onChange({ timeoutSeconds: event.target.value ? Number(event.target.value) : undefined })}
              />
            </Field>
            <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                checked={node.continueOnFailure === true}
                onChange={(event) => onChange({ continueOnFailure: event.target.checked })}
              />
              Continue the run if this node fails
            </label>
          </div>
        </details>

        {onPreview && definition.kind === "source" && (
          <Button size="sm" onClick={onPreview} disabled={previewDisabled}>Preview data</Button>
        )}
      </div>
    </div>
  );
}

function ConfigField({
  field, value, secrets, connections, upstreamNodeIds, error, onChange,
}: {
  field: FieldSchema;
  value: unknown;
  secrets: string[];
  connections: Array<{ id: string; name: string; family: string }>;
  upstreamNodeIds: string[];
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = `config-${field.name}`;
  const isSecretRef = typeof value === "object" && value !== null && "secretRef" in (value as object);
  const hint = field.description;

  // Connection and node references get a picker rather than a free-text box:
  // a typo here is the single most common cause of a 02:00 failure.
  if (field.name === "connectionId") {
    return (
      <Field label={field.label} htmlFor={id} hint={hint} {...(error ? { error } : {})}>
        <Select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select a connection…</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>{connection.name} ({connection.family})</option>
          ))}
        </Select>
        {connections.length === 0 && (
          <p className="text-[11px] text-[var(--color-warning)]">
            No matching connection exists. Create one under Connectors first.
          </p>
        )}
      </Field>
    );
  }
  if (field.name === "left" || field.name === "right") {
    return (
      <Field label={field.label} htmlFor={id} hint="Must be a node connected upstream of this one." {...(error ? { error } : {})}>
        <Select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select an upstream node…</option>
          {upstreamNodeIds.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
        </Select>
      </Field>
    );
  }

  if (field.type === "secret" || (field.secretAllowed && isSecretRef)) {
    return (
      <Field label={field.label} htmlFor={id} hint="References a stored secret. The value is resolved by the worker only." {...(error ? { error } : {})}>
        <Select
          id={id}
          value={isSecretRef ? (value as { secretRef: string }).secretRef : ""}
          onChange={(event) => onChange(event.target.value ? { secretRef: event.target.value } : undefined)}
        >
          <option value="">None</option>
          {secrets.map((secret) => <option key={secret} value={secret}>{secret}</option>)}
        </Select>
      </Field>
    );
  }

  switch (field.type) {
    case "sql":
    case "python":
      return (
        <Field label={field.label} hint={hint} {...(error ? { error } : {})}>
          <CodeEditor
            value={typeof value === "string" ? value : ""}
            language={field.type === "sql" ? "sql" : "python"}
            onChange={onChange}
            height={field.type === "python" ? 260 : 200}
            ariaLabel={field.label}
            {...(error ? { markers: [{ message: error, severity: "error" as const }] } : {})}
          />
        </Field>
      );
    case "object":
    case "array":
    case "json":
      return (
        <Field label={field.label} hint={hint} {...(error ? { error } : {})}>
          <CodeEditor
            value={JSON.stringify(value ?? (field.type === "array" ? [] : {}), null, 2)}
            language="json"
            height={150}
            ariaLabel={field.label}
            onChange={(next) => {
              try {
                onChange(JSON.parse(next));
              } catch {
                // Keep the user's text; validation will report it on save.
              }
            }}
          />
        </Field>
      );
    case "boolean":
      return (
        <label className="flex items-start gap-2 text-[12px]">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-medium text-[var(--color-text)]">{field.label}</span>
            {hint && <span className="block text-[11px] text-[var(--color-text-subtle)]">{hint}</span>}
          </span>
        </label>
      );
    case "enum":
      return (
        <Field label={field.label} htmlFor={id} hint={hint} {...(error ? { error } : {})}>
          <Select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
            {!field.required && <option value="">Not set</option>}
            {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        </Field>
      );
    case "number":
    case "integer":
      return (
        <Field label={field.label} htmlFor={id} hint={hint} {...(error ? { error } : {})}>
          <Input
            id={id}
            type="number"
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            step={field.type === "integer" ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          />
        </Field>
      );
    case "string[]":
      return (
        <Field label={field.label} htmlFor={id} hint={hint ?? "Comma separated."} {...(error ? { error } : {})}>
          <Input
            id={id}
            value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
            onChange={(event) => onChange(event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean))}
          />
        </Field>
      );
    case "text":
      return (
        <Field label={field.label} htmlFor={id} hint={hint} {...(error ? { error } : {})}>
          <Textarea id={id} rows={3} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />
        </Field>
      );
    default:
      return (
        <Field label={field.label} htmlFor={id} hint={hint} {...(error ? { error } : {})}>
          <Input
            id={id}
            value={typeof value === "string" ? value : ""}
            {...(field.placeholder ? { placeholder: field.placeholder } : {})}
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
      );
  }
}
