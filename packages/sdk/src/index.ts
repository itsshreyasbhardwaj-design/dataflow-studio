import { DataFlowHttpClient, type DataFlowClientOptions } from "@dataflow-studio/api-client";
import type {
  Backfill, Dataset, Incident, LogEntry, Page, Pipeline, PipelineSummary, PipelineVersion,
  QualityResult, Run, RunEventMessage, Schedule, Task, ValidationResult, WorkflowDefinition,
} from "./types.js";

export * from "./types.js";
export { DataFlowApiError, DataFlowNetworkError } from "@dataflow-studio/api-client";

export interface PipelineDetail {
  pipeline: Pipeline;
  versions: Array<Omit<PipelineVersion, "definition">>;
  currentVersion: PipelineVersion | null;
  recentRuns: Run[];
  schedules: Schedule[];
  validation: ValidationResult | null;
}

export interface RunDetail {
  run: Run;
  tasks: Task[];
  graph: { nodes: Array<{ id: string; type: string; label: string }>; edges: Array<{ from: string; to: string; port?: string }> };
  quality: QualityResult[];
}

/**
 * Official TypeScript SDK.
 *
 * ```ts
 * const client = new DataFlowClient({ apiKey: process.env.DATAFLOW_API_KEY });
 * const run = await client.pipelines.run("pipe_123");
 * const finished = await client.runs.waitFor(run.id);
 * ```
 */
export class DataFlowClient {
  private readonly http: DataFlowHttpClient;

  constructor(options: DataFlowClientOptions = {}) {
    this.http = new DataFlowHttpClient({ userAgent: "dataflow-sdk/0.1.0", ...options });
  }

  /** Escape hatch for endpoints the typed surface does not cover yet. */
  get raw(): DataFlowHttpClient {
    return this.http;
  }

  readonly me = {
    get: (): Promise<{ userId: string; organizationId: string; role: string; permissions: string[] }> =>
      this.http.get("/api/v1/me"),
  };

  readonly pipelines = {
    list: (options: { limit?: number; cursor?: string; search?: string; tag?: string } = {}): Promise<Page<PipelineSummary>> =>
      this.http.get("/api/v1/pipelines", { query: { ...options } }),

    get: (pipelineId: string): Promise<PipelineDetail> => this.http.get(`/api/v1/pipelines/${pipelineId}`),

    create: (input: { name: string; description?: string; definition?: WorkflowDefinition; tags?: string[] }): Promise<PipelineDetail> =>
      this.http.post("/api/v1/pipelines", input),

    update: (pipelineId: string, input: { description?: string; definition?: WorkflowDefinition; tags?: string[]; archived?: boolean }): Promise<PipelineDetail> =>
      this.http.patch(`/api/v1/pipelines/${pipelineId}`, input),

    delete: (pipelineId: string): Promise<{ deleted: boolean }> => this.http.delete(`/api/v1/pipelines/${pipelineId}`),

    /** Validates a stored pipeline, or a definition that has not been saved. */
    validate: (input: string | WorkflowDefinition): Promise<ValidationResult> =>
      typeof input === "string"
        ? this.http.post(`/api/v1/pipelines/${input}/validate`)
        : this.http.post("/api/v1/validate", { definition: input }),

    publish: (pipelineId: string, options: { versionId?: string } = {}): Promise<{ version: PipelineVersion; diff: unknown; validation: ValidationResult }> =>
      this.http.post(`/api/v1/pipelines/${pipelineId}/publish`, options),

    run: (pipelineId: string, options: { params?: Record<string, unknown>; logicalDate?: string; useDraft?: boolean } = {}): Promise<Run> =>
      this.http.post(`/api/v1/pipelines/${pipelineId}/run`, options),

    runs: (pipelineId: string, options: { limit?: number; cursor?: string; state?: string[] } = {}): Promise<Page<Run>> =>
      this.http.get(`/api/v1/pipelines/${pipelineId}/runs`, { query: { ...options } }),

    compare: (pipelineId: string, from: number, to: number): Promise<{ diff: { summary: string[] }; from: number; to: number }> =>
      this.http.get(`/api/v1/pipelines/${pipelineId}/compare`, { query: { from, to } }),

    fromTemplate: (templateId: string, name?: string): Promise<{ pipelineId: string; name: string }> =>
      this.http.post("/api/v1/pipelines/from-template", { templateId, ...(name ? { name } : {}) }),
  };

  readonly runs = {
    list: (options: { limit?: number; cursor?: string; pipelineId?: string; state?: string[]; since?: string } = {}): Promise<Page<Run>> =>
      this.http.get("/api/v1/runs", { query: { ...options } }),

    get: (runId: string): Promise<RunDetail> => this.http.get(`/api/v1/runs/${runId}`),

    cancel: (runId: string): Promise<Run> => this.http.post(`/api/v1/runs/${runId}/cancel`),

    retry: (runId: string, options: { fromNodes?: string[]; allNodes?: boolean } = {}): Promise<Run> =>
      this.http.post(`/api/v1/runs/${runId}/retry`, options),

    logs: (runId: string, options: { taskRunId?: string; level?: string; search?: string; limit?: number; cursor?: string } = {}): Promise<Page<LogEntry>> =>
      this.http.get(`/api/v1/runs/${runId}/logs`, { query: { ...options } }),

    task: (runId: string, taskRunId: string): Promise<{ task: Task; attempts: unknown[]; logs: LogEntry[]; config: Record<string, unknown> }> =>
      this.http.get(`/api/v1/runs/${runId}/tasks/${taskRunId}`),

    cancelTask: (runId: string, taskRunId: string): Promise<Task> =>
      this.http.post(`/api/v1/runs/${runId}/tasks/${taskRunId}/cancel`),

    investigate: (runId: string): Promise<Record<string, unknown>> => this.http.get(`/api/v1/runs/${runId}/investigate`),

    /** Live events for a run, resumable with `lastEventId`. */
    stream: (runId: string, options: { signal?: AbortSignal; lastEventId?: number } = {}): AsyncGenerator<RunEventMessage> =>
      this.http.streamEvents(`/api/v1/runs/${runId}/events`, options) as AsyncGenerator<RunEventMessage>,

    /**
     * Polls until a run reaches a terminal state. Used by CI: `dataflow pipeline run
     * --wait` exits non-zero when the run fails.
     */
    waitFor: async (
      runId: string,
      options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onUpdate?: (run: Run) => void } = {},
    ): Promise<Run> => {
      const timeoutMs = options.timeoutMs ?? 30 * 60_000;
      const pollMs = options.pollMs ?? 2000;
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const { run } = await this.runs.get(runId);
        options.onUpdate?.(run);
        if (["SUCCESS", "FAILED", "CANCELLED"].includes(run.state)) return run;
        if (Date.now() > deadline) {
          throw new Error(`Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s (state: ${run.state})`);
        }
        if (options.signal?.aborted) throw new Error("Aborted while waiting for the run");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };

  readonly datasets = {
    list: (options: { search?: string; limit?: number; cursor?: string } = {}): Promise<Page<Dataset>> =>
      this.http.get("/api/v1/datasets", { query: { ...options } }),
    get: (name: string): Promise<Record<string, unknown>> => this.http.get(`/api/v1/datasets/${encodeURIComponent(name)}`),
  };

  readonly lineage = {
    get: (options: { pipelineId?: string } = {}): Promise<{ nodes: unknown[]; edges: unknown[]; unresolved: unknown[] }> =>
      this.http.get("/api/v1/lineage", { query: { ...options } }),
  };

  readonly schedules = {
    list: (pipelineId?: string): Promise<Schedule[]> =>
      this.http.get("/api/v1/schedules", { query: { ...(pipelineId ? { pipelineId } : {}) } }),
    create: (input: { pipelineId: string; kind: "cron" | "interval"; cron?: string; intervalSeconds?: number; timezone?: string; catchup?: boolean }): Promise<Schedule> =>
      this.http.post("/api/v1/schedules", input),
    update: (scheduleId: string, input: { enabled?: boolean; cron?: string; intervalSeconds?: number; timezone?: string }): Promise<Schedule> =>
      this.http.patch(`/api/v1/schedules/${scheduleId}`, input),
    delete: (scheduleId: string): Promise<{ deleted: boolean }> => this.http.delete(`/api/v1/schedules/${scheduleId}`),
  };

  readonly backfills = {
    list: (pipelineId?: string): Promise<Backfill[]> =>
      this.http.get("/api/v1/backfills", { query: { ...(pipelineId ? { pipelineId } : {}) } }),
    create: (input: {
      pipelineId: string; from: string; to: string; intervalSeconds?: number;
      cron?: string; concurrency?: number; confirmLargeBackfill?: boolean;
    }): Promise<Backfill> => this.http.post("/api/v1/backfills", input),
    get: (backfillId: string): Promise<{ backfill: Backfill; percentComplete: number; remaining: number }> =>
      this.http.get(`/api/v1/backfills/${backfillId}`),
    setState: (backfillId: string, state: "running" | "paused" | "cancelled"): Promise<Backfill> =>
      this.http.post(`/api/v1/backfills/${backfillId}/state`, { state }),
  };

  readonly connections = {
    list: (): Promise<Array<{ id: string; name: string; family: string; lastTestOk?: boolean | null }>> =>
      this.http.get("/api/v1/connections"),
    create: (input: { name: string; family: string; config?: Record<string, unknown>; secretRefs?: Record<string, string> }): Promise<{ id: string; name: string }> =>
      this.http.post("/api/v1/connections", input),
    test: (connectionId: string): Promise<{ ok: boolean; message: string; latencyMs: number }> =>
      this.http.post(`/api/v1/connections/${connectionId}/test`),
    delete: (connectionId: string): Promise<{ deleted: boolean }> => this.http.delete(`/api/v1/connections/${connectionId}`),
  };

  readonly secrets = {
    /** Metadata only: the API has no endpoint that returns a secret value. */
    list: (): Promise<Array<{ name: string; fingerprint: string; updatedAt: string; backend: string }>> =>
      this.http.get("/api/v1/secrets"),
    create: (name: string, value: string, description?: string): Promise<{ name: string; fingerprint: string }> =>
      this.http.post("/api/v1/secrets", { name, value, ...(description ? { description } : {}) }),
    delete: (name: string): Promise<{ deleted: boolean }> => this.http.delete(`/api/v1/secrets/${encodeURIComponent(name)}`),
  };

  readonly incidents = {
    list: (options: { status?: string; kind?: string; limit?: number } = {}): Promise<Page<Incident>> =>
      this.http.get("/api/v1/incidents", { query: { ...options } }),
    update: (incidentId: string, status: "open" | "acknowledged" | "resolved"): Promise<Incident> =>
      this.http.patch(`/api/v1/incidents/${incidentId}`, { status }),
  };

  readonly analytics = {
    dashboard: (days?: number): Promise<Record<string, unknown>> =>
      this.http.get("/api/v1/dashboard", { query: { ...(days ? { days } : {}) } }),
    runs: (options: { from?: string; to?: string; pipelineId?: string } = {}): Promise<Record<string, unknown>> =>
      this.http.get("/api/v1/analytics", { query: { ...options } }),
  };

  readonly search = {
    query: (q: string, limit = 20): Promise<{ items: Array<{ type: string; id: string; title: string; href: string }> }> =>
      this.http.get("/api/v1/search", { query: { q, limit } }),
  };

  readonly health = {
    check: (): Promise<{ ok: boolean; driver: string; time: string }> => this.http.get("/api/v1/health"),
  };
}

export default DataFlowClient;
