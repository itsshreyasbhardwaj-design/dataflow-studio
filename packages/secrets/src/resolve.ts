import { isSecretReference, type NodeConfig } from "@dataflow-studio/workflow-engine";
import { SecretAccessDeniedError, type SecretProvider } from "./provider.js";

export interface ResolveOptions {
  organizationId: string;
  provider: SecretProvider;
  /**
   * Authorization hook. Returning false raises SecretAccessDeniedError, which is
   * how a Developer-role run is prevented from reading a production credential
   * it has no grant for.
   */
  authorize?: (name: string) => boolean | Promise<boolean>;
}

export interface ResolveResult<T> {
  value: T;
  /** Names of secrets that were actually read, for the audit log. */
  resolved: string[];
}

/**
 * Walks a node config and replaces every `{ secretRef }` with its plaintext.
 * Called exactly once per task attempt, inside the worker. The resolved object
 * must never be logged or returned over HTTP - see maskConfig for that.
 */
export async function resolveSecrets<T>(value: T, options: ResolveOptions): Promise<ResolveResult<T>> {
  const resolved = new Set<string>();

  const walk = async (input: unknown): Promise<unknown> => {
    if (isSecretReference(input)) {
      const name = input.secretRef;
      if (options.authorize && !(await options.authorize(name))) {
        throw new SecretAccessDeniedError(name);
      }
      const plaintext = await options.provider.read(options.organizationId, name);
      resolved.add(name);
      return plaintext;
    }
    if (Array.isArray(input)) return Promise.all(input.map(walk));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
        out[key] = await walk(nested);
      }
      return out;
    }
    return input;
  };

  return { value: (await walk(value)) as T, resolved: [...resolved] };
}

/**
 * Replaces every secret reference with a display placeholder. This is what the
 * API returns for a node config, so a browser never receives a credential even
 * transiently.
 */
export function maskConfig(config: NodeConfig): NodeConfig {
  const walk = (input: unknown): unknown => {
    if (isSecretReference(input)) return { secretRef: input.secretRef, masked: true };
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return input;
  };
  return walk(config) as NodeConfig;
}

/** Every secret name referenced anywhere in a value. */
export function collectReferences(value: unknown, out = new Set<string>()): Set<string> {
  if (isSecretReference(value)) { out.add(value.secretRef); return out; }
  if (Array.isArray(value)) { value.forEach((v) => collectReferences(v, out)); return out; }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) => collectReferences(v, out));
  }
  return out;
}
