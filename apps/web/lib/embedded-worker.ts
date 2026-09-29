import { capabilitiesOf } from "@dataflow-studio/database";
import { getRuntime } from "@dataflow-studio/api";
import { Worker } from "@dataflow-studio/worker";

/**
 * Embedded worker for local development.
 *
 * With the in-memory store there is no way for a separate worker process to see
 * the queue, so the web process runs one itself. This is what makes `pnpm dev`
 * work with no database, no Redis and no second terminal. With DATABASE_URL set,
 * the embedded worker stays off and `pnpm worker` owns execution - which is the
 * only arrangement that scales.
 */
// Cached globally for the same reason as the runtime: one worker per process,
// not one per module instance.
const WORKER_KEY = Symbol.for("dataflow-studio.embedded-worker");

interface GlobalWithWorker {
  [WORKER_KEY]?: Promise<Worker | null>;
}

export function startEmbeddedWorker(): Promise<Worker | null> {
  const container = globalThis as unknown as GlobalWithWorker;
  container[WORKER_KEY] ??= start();
  return container[WORKER_KEY];
}

async function start(): Promise<Worker | null> {
  if (process.env["EMBEDDED_WORKER"] === "false") return null;
  const runtime = await getRuntime();
  const capabilities = capabilitiesOf(runtime.store);

  if (capabilities.multiProcess && process.env["EMBEDDED_WORKER"] !== "true") {
    runtime.logger.info("Embedded worker disabled: DATABASE_URL is set, run `pnpm worker` instead");
    return null;
  }

  const worker = new Worker({
    store: runtime.store,
    engine: runtime.engine,
    logger: runtime.logger,
    concurrency: Number(process.env["WORKER_CONCURRENCY"] ?? 2),
    idlePollMs: 250,
    runScheduler: true,
    schedulerIntervalMs: 10_000,
  });
  void worker.start().catch((error: unknown) => {
    runtime.logger.error("Embedded worker stopped", { error: (error as Error).message });
  });
  runtime.logger.warn(
    "Embedded worker running inside the web process (in-memory store). " +
    "State is not durable and does not survive a restart - set DATABASE_URL for anything real.",
  );
  return worker;
}
