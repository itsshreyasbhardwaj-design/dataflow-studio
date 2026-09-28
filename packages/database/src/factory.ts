import { rootLogger } from "@dataflow-studio/observability";
import { MemoryStore } from "./memory-store.js";
import { createPostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";

let cached: Promise<Store> | null = null;

export interface StoreOptions {
  databaseUrl?: string | undefined;
  /** Runs pending migrations on first connect. */
  migrate?: boolean;
}

/**
 * Chooses a driver from the environment.
 *
 * With DATABASE_URL set we use PostgreSQL and workers can scale horizontally.
 * Without it we fall back to the in-memory driver, which keeps `pnpm dev`
 * working with no services at all - at the cost of durability, which the
 * dashboard states plainly rather than pretending otherwise.
 */
export async function createStore(options: StoreOptions = {}): Promise<Store> {
  const url = options.databaseUrl ?? process.env["DATABASE_URL"];
  if (!url) {
    rootLogger.warn("DATABASE_URL is not set; using the in-memory store (not durable, single process)");
    return new MemoryStore();
  }
  const store = await createPostgresStore(url, { ssl: /sslmode=require/.test(url) });
  if (options.migrate !== false) await store.migrate();
  return store;
}

/** Process-wide singleton, so Next.js route handlers share one pool. */
export function getStore(options: StoreOptions = {}): Promise<Store> {
  cached ??= createStore(options);
  return cached;
}

export function resetStoreForTests(): void {
  cached = null;
}
