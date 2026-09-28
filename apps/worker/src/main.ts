import { createServer } from "node:http";
import { policyFromEnvironment } from "@dataflow-studio/connectors";
import { capabilitiesOf, createStore } from "@dataflow-studio/database";
import { ExecutionEngine, sandboxFromEnvironment } from "@dataflow-studio/execution-engine";
import { JsonConsoleSink, Logger, metrics, type LogLevel } from "@dataflow-studio/observability";
import {
  CompositeSecretProvider, EnvironmentSecretProvider, ManagedSecretProvider, loadMasterKey,
  type SecretProvider,
} from "@dataflow-studio/secrets";
import { Worker } from "./worker.js";

const logger = new Logger({
  level: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info",
  sink: new JsonConsoleSink(),
});

const store = await createStore();
const capabilities = capabilitiesOf(store);
if (!capabilities.multiProcess) {
  logger.error(
    "This worker is using the in-memory store, which is not shared between processes. " +
    "It cannot see tasks created by the web app. Set DATABASE_URL to run a separate worker, " +
    "or use the web app's embedded worker for local development.",
  );
  process.exit(78);
}

let secrets: SecretProvider;
try {
  secrets = new CompositeSecretProvider([new ManagedSecretProvider(store, loadMasterKey()), new EnvironmentSecretProvider()]);
} catch (error) {
  logger.warn("ENCRYPTION_KEY is not set; only environment-provided secrets will resolve", { reason: (error as Error).message });
  secrets = new EnvironmentSecretProvider();
}

const engine = new ExecutionEngine({
  store,
  secrets,
  logger,
  sandbox: sandboxFromEnvironment(),
  egressPolicy: policyFromEnvironment(),
  ...(process.env["TASK_LEASE_SECONDS"] ? { leaseSeconds: Number(process.env["TASK_LEASE_SECONDS"]) } : {}),
});

const worker = new Worker({
  store,
  engine,
  logger,
  concurrency: Number(process.env["WORKER_CONCURRENCY"] ?? 4),
  ...(process.env["WORKER_NODE_TYPES"] ? { nodeTypes: process.env["WORKER_NODE_TYPES"].split(",").map((t) => t.trim()) } : {}),
  runScheduler: process.env["WORKER_RUN_SCHEDULER"] !== "false",
});

// A tiny health and metrics endpoint: the orchestrator needs a liveness probe, and
// the metrics are the ones the dashboard charts are derived from.
const port = Number(process.env["WORKER_PORT"] ?? 3002);
const server = createServer((request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(metrics.render());
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, ...worker.snapshot, driver: store.driver }));
});
server.listen(port, () => logger.info("Worker health endpoint listening", { port }));

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Draining worker", { signal });
    void worker.stop({ timeoutMs: Number(process.env["WORKER_DRAIN_MS"] ?? 30_000) }).then(async () => {
      server.close();
      await store.close?.();
      process.exit(0);
    });
  });
}

await worker.start();
