import { createStore, type Store } from "@dataflow-studio/database";
import { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { sandboxFromEnvironment } from "@dataflow-studio/execution-engine";
import { JsonConsoleSink, Logger, type LogLevel } from "@dataflow-studio/observability";
import {
  CompositeSecretProvider, EnvironmentSecretProvider, ManagedSecretProvider,
  loadMasterKey, type SecretProvider,
} from "@dataflow-studio/secrets";
import { policyFromEnvironment } from "@dataflow-studio/connectors";
import { authProviderFromEnvironment, type AuthProvider, type ClerkClaims } from "./auth.js";
import { createApiHandler } from "./router.js";
import { MemoryRateLimiter, type RateLimiter } from "./rate-limit.js";

export interface Runtime {
  store: Store;
  engine: ExecutionEngine;
  secrets: SecretProvider;
  auth: AuthProvider;
  rateLimiter: RateLimiter;
  logger: Logger;
  handler: (request: Request) => Promise<Response>;
}

/**
 * The runtime is cached on `globalThis`, not in a module-level variable.
 *
 * Bundlers (Next.js among them) can instantiate the same module more than once -
 * once for the server-component graph and once for route handlers. With a
 * module-level cache that produces two independent stores, so a run created
 * through the API would be invisible to the page rendering it. A global key is
 * the only place both instances can meet.
 */
const RUNTIME_KEY = Symbol.for("dataflow-studio.runtime");

interface GlobalWithRuntime {
  [RUNTIME_KEY]?: Promise<Runtime>;
}

export interface BootstrapOptions {
  resolveClerkClaims?: (request: Request) => Promise<ClerkClaims | null>;
}

/**
 * Builds the shared runtime: one store, one engine, one secret provider.
 *
 * Memoized per process so Next.js route handlers reuse a single connection pool
 * and, in in-memory mode, a single dataset.
 */
export async function getRuntime(options: BootstrapOptions = {}): Promise<Runtime> {
  const container = globalThis as unknown as GlobalWithRuntime;
  container[RUNTIME_KEY] ??= build(options);
  return container[RUNTIME_KEY];
}

async function build(options: BootstrapOptions): Promise<Runtime> {
  const logger = new Logger({
    level: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info",
    sink: new JsonConsoleSink(),
  });
  const store = await createStore();

  // A managed secret provider needs an encryption key; without one we fall back to
  // environment-injected secrets, which is the sane default for local development.
  let secrets: SecretProvider;
  try {
    secrets = new CompositeSecretProvider([
      new ManagedSecretProvider(store, loadMasterKey()),
      new EnvironmentSecretProvider(),
    ]);
  } catch (error) {
    logger.warn("ENCRYPTION_KEY is not set; only environment-provided secrets are available", {
      reason: (error as Error).message,
    });
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

  const auth = authProviderFromEnvironment(options.resolveClerkClaims);
  const rateLimiter = new MemoryRateLimiter();
  const handler = createApiHandler({ store, engine, secrets, auth, rateLimiter, logger });

  return { store, engine, secrets, auth, rateLimiter, logger, handler };
}

export function resetRuntimeForTests(): void {
  delete (globalThis as unknown as GlobalWithRuntime)[RUNTIME_KEY];
}
