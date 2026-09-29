"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Play, RotateCcw, Sparkles, StopCircle, Upload } from "lucide-react";
import { api, issuesOf, type ClientError } from "./api-client";
import { Banner, Button, Dialog, Field, Input, Select } from "./ui";

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ClientError | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (body: () => Promise<void>, options: { redirect?: string } = {}): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await body();
      startTransition(() => {
        if (options.redirect) router.push(options.redirect);
        else router.refresh();
      });
    } catch (caught) {
      setError(caught as ClientError);
    } finally {
      setBusy(false);
    }
  };

  return { run, busy: busy || pending, error, setError };
}

function ErrorNote({ error }: { error: ClientError | null }) {
  if (!error) return null;
  const issues = issuesOf(error);
  return (
    <Banner tone="danger" title={error.message}>
      {issues.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {issues.map((issue, index) => (
            <li key={index}>
              {issue.nodeId && <span className="mono">[{issue.nodeId}] </span>}
              {issue.message}
              {issue.hint && <span className="block text-[var(--color-text-subtle)]">{issue.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      {error.requestId && <span className="mono mt-1 block text-[11px] text-[var(--color-text-subtle)]">{error.requestId}</span>}
    </Banner>
  );
}

export function SeedDemoButton() {
  const { run, busy, error } = useAction();
  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        loading={busy}
        onClick={() => void run(async () => { await api.post("/api/v1/demo/seed", { execute: true }); })}
      >
        <Sparkles className="size-3.5" aria-hidden /> Seed and run demo pipeline
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}

export function RunPipelineButton({ pipelineId, disabled, hint }: { pipelineId: string; disabled?: boolean; hint?: string }) {
  const { run, busy, error } = useAction();
  const router = useRouter();
  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        disabled={disabled}
        title={hint}
        onClick={() => void run(async () => {
          const created = await api.post<{ id: string }>(`/api/v1/pipelines/${pipelineId}/run`, {});
          router.push(`/runs/${created.id}`);
        })}
      >
        <Play className="size-3.5" aria-hidden /> Run
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}

export function PublishButton({ pipelineId, disabled }: { pipelineId: string; disabled?: boolean }) {
  const { run, busy, error } = useAction();
  const [summary, setSummary] = useState<string[] | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        loading={busy}
        disabled={disabled}
        onClick={() => void run(async () => {
          const result = await api.post<{ diff: { summary?: string[] } | null; version: { version: number } }>(
            `/api/v1/pipelines/${pipelineId}/publish`, {},
          );
          setSummary(result.diff?.summary ?? [`Published v${result.version.version}`]);
        })}
      >
        <Upload className="size-3.5" aria-hidden /> Publish
      </Button>
      {summary && (
        <Banner tone="success" title="Published">
          <ul className="mono space-y-0.5">{summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </Banner>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

export function CancelRunButton({ runId }: { runId: string }) {
  const { run, busy, error } = useAction();
  return (
    <div className="space-y-2">
      <Button variant="danger" size="sm" loading={busy} onClick={() => void run(async () => { await api.post(`/api/v1/runs/${runId}/cancel`); })}>
        <StopCircle className="size-3.5" aria-hidden /> Cancel run
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}

export function RetryRunButton({ runId }: { runId: string }) {
  const { run, busy, error } = useAction();
  const router = useRouter();
  const [allNodes, setAllNodes] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          loading={busy}
          onClick={() => void run(async () => {
            const retried = await api.post<{ id: string }>(`/api/v1/runs/${runId}/retry`, { allNodes });
            router.push(`/runs/${retried.id}`);
          })}
        >
          <RotateCcw className="size-3.5" aria-hidden /> Retry
        </Button>
        <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={allNodes} onChange={(event) => setAllNodes(event.target.checked)} />
          all nodes
        </label>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

export function CancelTaskButton({ runId, taskRunId }: { runId: string; taskRunId: string }) {
  const { run, busy } = useAction();
  return (
    <Button variant="ghost" size="sm" loading={busy} onClick={() => void run(async () => { await api.post(`/api/v1/runs/${runId}/tasks/${taskRunId}/cancel`); })}>
      Cancel task
    </Button>
  );
}

export function CreatePipelineForm({ templates }: { templates: Array<{ id: string; title: string; category: string; requires: string[] }> }) {
  const { run, busy, error } = useAction();
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");

  const valid = /^[a-z0-9][a-z0-9_-]{1,63}$/.test(name);
  const template = templates.find((t) => t.id === templateId);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (templateId) {
            const created = await api.post<{ pipelineId: string }>("/api/v1/pipelines/from-template", { templateId, name });
            router.push(`/pipelines/${created.pipelineId}/editor`);
          } else {
            const created = await api.post<{ pipeline: { id: string } }>("/api/v1/pipelines", { name });
            router.push(`/pipelines/${created.pipeline.id}/editor`);
          }
        });
      }}
    >
      <Field
        label="Pipeline name"
        htmlFor="pipeline-name"
        hint="Lowercase letters, digits, dashes and underscores. Used in the API, the CLI and logs."
        {...(name && !valid ? { error: "2-64 characters, must start with a letter or digit" } : {})}
      >
        <Input
          id="pipeline-name"
          value={name}
          onChange={(event) => setName(event.target.value.toLowerCase())}
          placeholder="daily-sales"
          autoFocus
          required
        />
      </Field>

      <Field label="Start from" htmlFor="pipeline-template" hint="Templates are examples: they are created as a draft and never published automatically.">
        <Select id="pipeline-template" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
          <option value="">Empty pipeline</option>
          {templates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
          ))}
        </Select>
      </Field>

      {template && template.requires.length > 0 && (
        <Banner tone="info" title="This template needs">
          <ul className="list-inside list-disc">{template.requires.map((item) => <li key={item}>{item}</li>)}</ul>
        </Banner>
      )}

      <ErrorNote error={error} />
      <Button type="submit" variant="primary" loading={busy} disabled={!valid}>Create pipeline</Button>
    </form>
  );
}

export function ConnectionDialog({ secrets }: { secrets: Array<{ name: string }> }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  const [name, setName] = useState("");
  const [family, setFamily] = useState("postgres");
  const [config, setConfig] = useState("{\n  \"host\": \"db.internal\",\n  \"port\": 5432,\n  \"database\": \"app\",\n  \"user\": \"dataflow\"\n}");
  const [passwordSecret, setPasswordSecret] = useState("");

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>New connection</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New connection"
        description="Settings are stored as-is; credentials must reference a stored secret."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void run(async () => {
                await api.post("/api/v1/connections", {
                  name,
                  family,
                  config: JSON.parse(config) as Record<string, unknown>,
                  ...(passwordSecret ? { secretRefs: { password: passwordSecret } } : {}),
                });
                setOpen(false);
              })}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="connection-name">
            <Input id="connection-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="prod-warehouse" />
          </Field>
          <Field label="Family" htmlFor="connection-family">
            <Select id="connection-family" value={family} onChange={(event) => setFamily(event.target.value)}>
              {["postgres", "mysql", "http", "s3"].map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
          </Field>
          <Field label="Configuration (JSON)" htmlFor="connection-config" hint="Never put a password here - the API rejects it.">
            <textarea
              id="connection-config"
              value={config}
              onChange={(event) => setConfig(event.target.value)}
              rows={7}
              className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2 py-1.5 mono focus:border-[var(--color-accent)] focus:outline-none"
            />
          </Field>
          <Field label="Password secret" htmlFor="connection-secret" hint="The worker resolves this at run time; it is never sent to the browser.">
            <Select id="connection-secret" value={passwordSecret} onChange={(event) => setPasswordSecret(event.target.value)}>
              <option value="">None</option>
              {secrets.map((secret) => <option key={secret.name} value={secret.name}>{secret.name}</option>)}
            </Select>
          </Field>
          <ErrorNote error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function SecretDialog() {
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>New secret</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New secret"
        description="Encrypted with a key derived per organization. The value can never be read back through the API."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name || !value}
              onClick={() => void run(async () => {
                await api.post("/api/v1/secrets", { name, value });
                setValue("");
                setOpen(false);
              })}
            >
              Store secret
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="secret-name" hint={'Referenced from a node as { secretRef: "name" }.'}>
            <Input id="secret-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="prod-postgres-password" />
          </Field>
          <Field label="Value" htmlFor="secret-value">
            <Input id="secret-value" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
          </Field>
          <ErrorNote error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function ScheduleDialog({ pipelineId, disabled }: { pipelineId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  const [kind, setKind] = useState<"cron" | "interval">("cron");
  const [cron, setCron] = useState("0 2 * * *");
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [catchup, setCatchup] = useState(false);

  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>Schedule</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule this pipeline"
        description="Schedules always run the published version unless a version is pinned."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void run(async () => {
                await api.post("/api/v1/schedules", {
                  pipelineId,
                  kind,
                  ...(kind === "cron" ? { cron } : { intervalSeconds: intervalMinutes * 60 }),
                  timezone,
                  catchup,
                });
                setOpen(false);
              })}
            >
              Create schedule
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Kind" htmlFor="schedule-kind">
            <Select id="schedule-kind" value={kind} onChange={(event) => setKind(event.target.value as "cron" | "interval")}>
              <option value="cron">Cron expression</option>
              <option value="interval">Fixed interval</option>
            </Select>
          </Field>
          {kind === "cron" ? (
            <Field label="Cron" htmlFor="schedule-cron" hint="Five fields: minute hour day-of-month month day-of-week. Macros like @daily work too.">
              <Input id="schedule-cron" className="mono" value={cron} onChange={(event) => setCron(event.target.value)} />
            </Field>
          ) : (
            <Field label="Every (minutes)" htmlFor="schedule-interval" hint="Minimum 1 minute.">
              <Input id="schedule-interval" type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} />
            </Field>
          )}
          <Field label="Timezone" htmlFor="schedule-tz" hint="Stored explicitly, so DST changes do not shift the schedule.">
            <Input id="schedule-tz" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <input type="checkbox" checked={catchup} onChange={(event) => setCatchup(event.target.checked)} />
            Catch up on missed intervals after an outage
          </label>
          <ErrorNote error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function BackfillDialog({ pipelineId, disabled }: { pipelineId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [concurrency, setConcurrency] = useState(2);
  const [confirm, setConfirm] = useState(false);

  const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);

  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>Backfill</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Backfill"
        description="Replays the published version once per interval across a past date range."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void run(async () => {
                await api.post("/api/v1/backfills", {
                  pipelineId,
                  from: new Date(`${from}T00:00:00Z`).toISOString(),
                  to: new Date(`${to}T00:00:00Z`).toISOString(),
                  intervalSeconds: 86_400,
                  concurrency,
                  confirmLargeBackfill: confirm,
                });
                setOpen(false);
              })}
            >
              Start backfill
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="backfill-from"><Input id="backfill-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
            <Field label="To" htmlFor="backfill-to"><Input id="backfill-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field>
          </div>
          <Field label="Concurrency" htmlFor="backfill-concurrency" hint="How many logical dates run at once. Keep it low against production systems.">
            <Input id="backfill-concurrency" type="number" min={1} max={20} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
          </Field>
          <Banner tone={days > 100 ? "warning" : "info"}>
            This will create <strong>{days}</strong> run{days === 1 ? "" : "s"}, one per day.
          </Banner>
          {days > 100 && (
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
              I understand this starts {days} runs
            </label>
          )}
          <ErrorNote error={error} />
        </div>
      </Dialog>
    </>
  );
}

export function IncidentActions({ incidentId, status }: { incidentId: string; status: string }) {
  const { run, busy } = useAction();
  return (
    <div className="flex items-center gap-1.5">
      {status === "open" && (
        <Button variant="ghost" size="sm" loading={busy} onClick={() => void run(async () => { await api.patch(`/api/v1/incidents/${incidentId}`, { status: "acknowledged" }); })}>
          Acknowledge
        </Button>
      )}
      {status !== "resolved" && (
        <Button variant="ghost" size="sm" loading={busy} onClick={() => void run(async () => { await api.patch(`/api/v1/incidents/${incidentId}`, { status: "resolved" }); })}>
          Resolve
        </Button>
      )}
    </div>
  );
}

export function DeleteButton({ path, label = "Delete", confirmText }: { path: string; label?: string; confirmText?: string }) {
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>{label}</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        description={confirmText ?? "This cannot be undone."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={() => void run(async () => { await api.delete(path); setOpen(false); })}>
              {label}
            </Button>
          </>
        }
      >
        <ErrorNote error={error} />
      </Dialog>
    </>
  );
}

export function ApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  const [name, setName] = useState("");
  const [role, setRole] = useState("developer");
  const [token, setToken] = useState<string | null>(null);

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => { setToken(null); setOpen(true); }}>New API key</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New API key"
        description="Used by the CLI, CI and the SDK. The value is shown once."
        footer={
          token ? <Button variant="primary" onClick={() => setOpen(false)}>Done</Button> : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!name}
                onClick={() => void run(async () => {
                  const created = await api.post<{ token: string }>("/api/v1/api-keys", { name, role });
                  setToken(created.token);
                })}
              >
                Create key
              </Button>
            </>
          )
        }
      >
        {token ? (
          <div className="space-y-2">
            <Banner tone="warning" title="Copy this now">
              This is the only time the key is shown. Only its SHA-256 hash is stored.
            </Banner>
            <pre className="overflow-x-auto rounded border border-[var(--color-border-strong)] bg-[var(--color-canvas)] p-2 mono">{token}</pre>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Name" htmlFor="key-name"><Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="ci-deploy" /></Field>
            <Field label="Role" htmlFor="key-role" hint="A key cannot exceed your own permissions.">
              <Select id="key-role" value={role} onChange={(event) => setRole(event.target.value)}>
                {["viewer", "developer", "admin"].map((option) => <option key={option} value={option}>{option}</option>)}
              </Select>
            </Field>
            <ErrorNote error={error} />
          </div>
        )}
      </Dialog>
    </>
  );
}
