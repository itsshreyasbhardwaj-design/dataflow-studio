/**
 * Seeds a development organization with demo pipelines and executes them.
 *
 * Everything it creates is labelled `isDemo`, so the dashboard can distinguish it
 * from real work and it can be filtered out of analytics. Run with:
 *
 *   pnpm seed                     # seed and execute
 *   pnpm seed -- --no-execute     # seed definitions only
 *   pnpm seed -- --runs 5         # execute the demo pipeline several times
 */
import { createContext, services } from "@dataflow-studio/api";
import { createStore } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { JsonConsoleSink, Logger } from "@dataflow-studio/observability";
import { EnvironmentSecretProvider, ManagedSecretProvider, loadMasterKey } from "@dataflow-studio/secrets";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const organizationId = value("organization") ?? process.env["LOCAL_ORGANIZATION_ID"] ?? "org_local";
const userId = process.env["LOCAL_USER_ID"] ?? "local-user";
const execute = !flag("no-execute");
const runs = Number(value("runs") ?? 1);

const logger = new Logger({ level: "info", sink: new JsonConsoleSink() });
const store = await createStore();

let secrets;
try {
  secrets = new ManagedSecretProvider(store, loadMasterKey());
} catch {
  secrets = new EnvironmentSecretProvider();
}

const engine = new ExecutionEngine({ store, secrets, logger });

if (!(await store.getOrganization(organizationId))) {
  await store.createOrganization({
    id: organizationId,
    name: "Local development",
    slug: organizationId.replace(/^org_/, "") || "local",
    createdAt: new Date().toISOString(),
    isDemo: true,
  });
}
if (!(await store.getMember(organizationId, userId))) {
  await store.upsertMember({ organizationId, userId, role: "owner", createdAt: new Date().toISOString() });
}

const context = createContext({
  store,
  engine,
  secrets,
  principal: { userId, organizationId, role: "owner", actorType: "user" },
  requestId: "req_seed",
  logger,
});

const seeded = await services.demo.seedDemoData(context, { execute });
logger.info("Seeded demo pipelines", { pipelines: seeded.pipelines.map((pipeline) => pipeline.name) });

// Extra runs give the dashboard charts something to plot.
for (let i = 1; i < runs; i++) {
  for (const pipeline of seeded.pipelines) {
    const run = await services.pipelines.runPipeline(context, pipeline.id, {});
    await engine.executeRunToCompletion(organizationId, run.id);
  }
}

const dashboard = await services.analytics.getDashboard(context);
logger.info("Seed complete", {
  driver: store.driver,
  pipelines: dashboard.pipelines.total,
  runs: dashboard.runs.total,
  succeeded: dashboard.runs.succeeded,
  datasets: (await store.listDatasets(organizationId)).items.length,
});

if (store.driver === "memory") {
  logger.warn("This used the in-memory store, so the seeded data disappears when this process exits. Set DATABASE_URL to seed a real database.");
}

await store.close?.();
