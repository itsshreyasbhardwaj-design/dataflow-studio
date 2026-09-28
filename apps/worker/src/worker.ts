import type { Store, TaskRun } from "@dataflow-studio/database";
import { ExecutionEngine, detectStaleDatasets, type TaskOutcome } from "@dataflow-studio/execution-engine";
import { Logger, metrics, newWorkerId, rootLogger } from "@dataflow-studio/observability";
import { advanceBackfill, dispatchDueSchedules } from "@dataflow-studio/scheduler";

export interface WorkerOptions {
  store: Store;
  engine: ExecutionEngine;
  logger?: Logger;
  /** Tasks executed at once by this worker. */
  concurrency?: number;
  /** Sleep between empty polls. */
  idlePollMs?: number;
  leaseSeconds?: number;
  /** Restrict this worker to specific node types, for heterogeneous pools. */
  nodeTypes?: string[];
  /** Disable to run scheduling in a separate process. */
  runScheduler?: boolean;
  schedulerIntervalMs?: number;
  reclaimIntervalMs?: number;
  staleCheckIntervalMs?: number;
  clock?: () => Date;
}

export interface WorkerStats {
  workerId: string;
  tasksExecuted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksRetried: number;
  schedulesDispatched: number;
  leasesReclaimed: number;
  startedAt: string;
  inFlight: number;
}

const DEFAULTS = {
  concurrency: 4,
  idlePollMs: 500,
  leaseSeconds: 120,
  schedulerIntervalMs: 15_000,
  reclaimIntervalMs: 30_000,
  staleCheckIntervalMs: 5 * 60_000,
};

/**
 * The worker process.
 *
 * It does one thing in a loop: claim a ready task and execute it. Claiming is
 * atomic in the store, so any number of workers can run against the same
 * PostgreSQL database without coordination, and a worker that dies mid-task has
 * its work reclaimed when the lease expires.
 *
 * Scheduling, backfill dispatch, lease reclamation and staleness detection run on
 * their own timers. They are enabled per worker so a deployment can separate the
 * "scheduler" role from the "executor" role if it wants to.
 */
export class Worker {
  readonly workerId: string;
  private readonly options: Required<Omit<WorkerOptions, "store" | "engine" | "logger" | "nodeTypes" | "runScheduler" | "clock">> &
    Pick<WorkerOptions, "nodeTypes" | "runScheduler" | "clock">;
  private readonly logger: Logger;
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;
  private draining = false;
  private inFlight = 0;
  private readonly stats: WorkerStats;

  constructor(private readonly config: WorkerOptions) {
    this.workerId = newWorkerId();
    this.logger = (config.logger ?? rootLogger).child({ workerId: this.workerId });
    this.options = {
      concurrency: config.concurrency ?? DEFAULTS.concurrency,
      idlePollMs: config.idlePollMs ?? DEFAULTS.idlePollMs,
      leaseSeconds: config.leaseSeconds ?? DEFAULTS.leaseSeconds,
      schedulerIntervalMs: config.schedulerIntervalMs ?? DEFAULTS.schedulerIntervalMs,
      reclaimIntervalMs: config.reclaimIntervalMs ?? DEFAULTS.reclaimIntervalMs,
      staleCheckIntervalMs: config.staleCheckIntervalMs ?? DEFAULTS.staleCheckIntervalMs,
      ...(config.nodeTypes ? { nodeTypes: config.nodeTypes } : {}),
      ...(config.runScheduler !== undefined ? { runScheduler: config.runScheduler } : {}),
      ...(config.clock ? { clock: config.clock } : {}),
    };
    this.stats = {
      workerId: this.workerId,
      tasksExecuted: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      tasksRetried: 0,
      schedulesDispatched: 0,
      leasesReclaimed: 0,
      startedAt: new Date().toISOString(),
      inFlight: 0,
    };
  }

  get snapshot(): WorkerStats {
    return { ...this.stats, inFlight: this.inFlight };
  }

  /** Claims and executes one task. Returns null when the queue is empty. */
  async executeOne(): Promise<TaskOutcome | null> {
    const claimed = await this.config.store.claimNextTask({
      workerId: this.workerId,
      leaseSeconds: this.options.leaseSeconds,
      ...(this.options.clock ? { now: this.options.clock() } : {}),
      ...(this.options.nodeTypes ? { nodeTypes: this.options.nodeTypes } : {}),
    });
    if (!claimed) return null;

    this.inFlight++;
    metrics.gauge("dataflow_worker_in_flight", this.inFlight, { worker: this.workerId });
    try {
      const outcome = await this.config.engine.runTask(claimed as TaskRun);
      this.stats.tasksExecuted++;
      if (outcome.state === "SUCCESS") this.stats.tasksSucceeded++;
      else if (outcome.state === "RETRYING") this.stats.tasksRetried++;
      else this.stats.tasksFailed++;
      return outcome;
    } catch (error) {
      // A throw here means the engine itself failed, not the task: log loudly and
      // release the lease so another worker can try.
      this.stats.tasksFailed++;
      this.logger.error("Worker failed while executing a task", {
        taskId: claimed.id,
        nodeId: claimed.nodeId,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      await this.config.store
        .updateTask(claimed.organizationId, claimed.id, { state: "QUEUED", workerId: null, leaseExpiresAt: null })
        .catch(() => undefined);
      return null;
    } finally {
      this.inFlight--;
      metrics.gauge("dataflow_worker_in_flight", this.inFlight, { worker: this.workerId });
    }
  }

  async tickScheduler(): Promise<number> {
    const results = await dispatchDueSchedules(this.config.store, {
      ...(this.options.clock ? { now: this.options.clock() } : {}),
      startRun: async ({ schedule, logicalDate }) => {
        const pipeline = await this.config.store.getPipeline(schedule.organizationId, schedule.pipelineId);
        if (!pipeline) return null;
        const versionId = schedule.pipelineVersionId ?? pipeline.publishedVersionId;
        if (!versionId) {
          this.logger.warn("Schedule skipped: pipeline has no published version", {
            scheduleId: schedule.id,
            pipelineId: schedule.pipelineId,
          });
          return null;
        }
        const version = await this.config.store.getVersion(schedule.organizationId, versionId);
        if (!version) return null;

        return this.config.engine.startRun({
          organizationId: schedule.organizationId,
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          pipelineVersionId: version.id,
          version: version.version,
          definition: version.definition,
          trigger: "schedule",
          triggeredBy: `schedule:${schedule.id}`,
          scheduleId: schedule.id,
          logicalDate,
          ...(pipeline.isDemo ? { isDemo: true } : {}),
        });
      },
    });

    const dispatched = results.reduce((sum, result) => sum + result.runIds.length, 0);
    this.stats.schedulesDispatched += dispatched;
    if (dispatched) {
      metrics.increment("dataflow_schedules_dispatched_total", {}, dispatched);
      this.logger.info("Dispatched scheduled runs", { count: dispatched });
    }
    for (const result of results) {
      if (result.error) this.logger.error("Schedule dispatch failed", { scheduleId: result.scheduleId, error: result.error });
      if (result.skippedIntervals) {
        this.logger.warn("Schedule skipped missed intervals (catchup is off)", {
          scheduleId: result.scheduleId,
          skipped: result.skippedIntervals,
        });
      }
    }
    return dispatched;
  }

  async tickBackfills(): Promise<number> {
    const active = await this.config.store.listActiveBackfills(20);
    let dispatched = 0;

    for (const backfill of active) {
      const progress = await advanceBackfill(this.config.store, backfill.organizationId, backfill.id, {
        ...(this.options.clock ? { now: this.options.clock() } : {}),
        startRun: async ({ backfill: record, logicalDate }) => {
          const pipeline = await this.config.store.getPipeline(record.organizationId, record.pipelineId);
          const version = await this.config.store.getVersion(record.organizationId, record.pipelineVersionId);
          if (!pipeline || !version) return null;
          dispatched++;
          return this.config.engine.startRun({
            organizationId: record.organizationId,
            pipelineId: record.pipelineId,
            pipelineName: pipeline.name,
            pipelineVersionId: version.id,
            version: version.version,
            definition: version.definition,
            trigger: "backfill",
            triggeredBy: record.createdBy,
            backfillId: record.id,
            logicalDate,
            ...(pipeline.isDemo ? { isDemo: true } : {}),
          });
        },
      }).catch((error: unknown) => {
        this.logger.error("Backfill dispatch failed", { backfillId: backfill.id, error: (error as Error).message });
        return null;
      });

      if (progress?.state === "completed" || progress?.state === "failed") {
        this.logger.info("Backfill finished", { backfillId: backfill.id, state: progress.state, completed: progress.completed, failed: progress.failed });
      }
    }
    return dispatched;
  }

  async reclaimLeases(): Promise<number> {
    const reclaimed = await this.config.store.reclaimExpiredLeases(this.options.clock?.());
    if (reclaimed.length) {
      this.stats.leasesReclaimed += reclaimed.length;
      metrics.increment("dataflow_leases_reclaimed_total", {}, reclaimed.length);
      this.logger.warn("Reclaimed tasks from expired leases", {
        count: reclaimed.length,
        tasks: reclaimed.slice(0, 10).map((t) => t.nodeId),
      });
      // A reclaimed task may be the last one a run was waiting on.
      for (const task of reclaimed) {
        await this.config.engine.advanceRun(task.organizationId, task.runId).catch(() => undefined);
      }
    }
    return reclaimed.length;
  }

  async checkStaleDatasets(): Promise<number> {
    // Staleness is the absence of an event, so it has to be checked on a timer.
    const organizations = new Set<string>();
    for (const backfill of await this.config.store.listActiveBackfills(50)) organizations.add(backfill.organizationId);
    const schedules = await this.config.store.claimDueSchedules(new Date(Date.now() + 365 * 86_400_000), 200);
    for (const schedule of schedules) organizations.add(schedule.organizationId);

    let opened = 0;
    for (const organizationId of organizations) {
      const incidents = await detectStaleDatasets(this.config.store, organizationId, {
        ...(this.options.clock ? { now: this.options.clock() } : {}),
      }).catch(() => []);
      opened += incidents.length;
    }
    return opened;
  }

  /** Runs until `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) throw new Error("Worker is already running");
    this.running = true;
    this.logger.info("Worker started", {
      concurrency: this.options.concurrency,
      driver: this.config.store.driver,
      nodeTypes: this.options.nodeTypes ?? "all",
      scheduler: this.options.runScheduler !== false,
    });

    if (this.options.runScheduler !== false) {
      this.timers.push(setInterval(() => {
        void this.tickScheduler().catch((error: unknown) => this.logger.error("Scheduler tick failed", { error: (error as Error).message }));
        void this.tickBackfills().catch((error: unknown) => this.logger.error("Backfill tick failed", { error: (error as Error).message }));
      }, this.options.schedulerIntervalMs));

      this.timers.push(setInterval(() => {
        void this.checkStaleDatasets().catch((error: unknown) => this.logger.error("Stale check failed", { error: (error as Error).message }));
      }, this.options.staleCheckIntervalMs));
    }

    this.timers.push(setInterval(() => {
      void this.reclaimLeases().catch((error: unknown) => this.logger.error("Lease reclaim failed", { error: (error as Error).message }));
    }, this.options.reclaimIntervalMs));

    const loops = Array.from({ length: this.options.concurrency }, () => this.loop());
    await Promise.all(loops);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const outcome = await this.executeOne();
        if (!outcome) await sleep(this.options.idlePollMs);
      } catch (error) {
        this.logger.error("Worker loop error", { error: (error as Error).message });
        await sleep(Math.min(this.options.idlePollMs * 10, 5000));
      }
    }
  }

  /** Stops claiming new work and waits for in-flight tasks to finish. */
  async stop(options: { timeoutMs?: number } = {}): Promise<WorkerStats> {
    if (this.draining) return this.snapshot;
    this.draining = true;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;

    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (this.inFlight > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.inFlight > 0) {
      this.logger.warn("Shutting down with tasks still in flight; their leases will be reclaimed", { inFlight: this.inFlight });
    }
    this.logger.info("Worker stopped", this.snapshot as unknown as Record<string, unknown>);
    return this.snapshot;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
