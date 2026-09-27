import { deriveDataKey, decryptSecret, encryptSecret, loadMasterKey, secretFingerprint } from "./crypto.js";

export interface SecretMetadata {
  name: string;
  description?: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** Where the value lives. `managed` means we hold the ciphertext. */
  backend: "managed" | "environment" | "external";
}

export interface SecretRecord extends SecretMetadata {
  organizationId: string;
  /** Envelope-encrypted value. Never leaves the worker or API process. */
  ciphertext?: string;
  /** For `external` secrets: the provider-specific URI, e.g. `vault://kv/prod#token`. */
  externalUri?: string;
}

/** Storage contract, implemented by @dataflow-studio/database. */
export interface SecretRecordStore {
  getSecret(organizationId: string, name: string): Promise<SecretRecord | null>;
  listSecrets(organizationId: string): Promise<SecretRecord[]>;
  upsertSecret(record: SecretRecord): Promise<SecretRecord>;
  deleteSecret(organizationId: string, name: string): Promise<boolean>;
  touchSecret?(organizationId: string, name: string, at: string): Promise<void>;
}

export class SecretNotFoundError extends Error {
  readonly errorClass = "not_found";
  constructor(name: string) {
    super(`Secret "${name}" does not exist`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretAccessDeniedError extends Error {
  readonly errorClass = "permission";
  constructor(name: string) {
    super(`Not authorized to read secret "${name}"`);
    this.name = "SecretAccessDeniedError";
  }
}

export interface SecretProvider {
  /** Resolves a secret to its plaintext value. */
  read(organizationId: string, name: string): Promise<string>;
  /** Metadata only - safe to return to a browser. */
  describe(organizationId: string, name: string): Promise<SecretMetadata | null>;
  list(organizationId: string): Promise<SecretMetadata[]>;
  write(organizationId: string, name: string, value: string, description?: string): Promise<SecretMetadata>;
  delete(organizationId: string, name: string): Promise<boolean>;
}

const SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function assertValidSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`Invalid secret name "${name}": use letters, digits, dot, dash or underscore`);
  }
}

/** Envelope-encrypted secrets held in our own store. The default backend. */
export class ManagedSecretProvider implements SecretProvider {
  private readonly masterKey: Buffer;

  constructor(
    private readonly store: SecretRecordStore,
    masterKey?: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.masterKey = masterKey ?? loadMasterKey();
  }

  async read(organizationId: string, name: string): Promise<string> {
    assertValidSecretName(name);
    const record = await this.store.getSecret(organizationId, name);
    if (!record) throw new SecretNotFoundError(name);

    if (record.backend === "environment") {
      const value = process.env[envVarName(name)];
      if (value === undefined) throw new SecretNotFoundError(name);
      return value;
    }
    if (record.backend === "external") {
      throw new Error(
        `Secret "${name}" is an external reference (${record.externalUri}); configure an external secret provider to resolve it`,
      );
    }
    if (!record.ciphertext) throw new SecretNotFoundError(name);

    const value = decryptSecret(
      record.ciphertext,
      deriveDataKey(this.masterKey, organizationId),
      `${organizationId}:${name}`,
    );
    await this.store.touchSecret?.(organizationId, name, this.clock().toISOString());
    return value;
  }

  async describe(organizationId: string, name: string): Promise<SecretMetadata | null> {
    const record = await this.store.getSecret(organizationId, name);
    return record ? toMetadata(record) : null;
  }

  async list(organizationId: string): Promise<SecretMetadata[]> {
    return (await this.store.listSecrets(organizationId)).map(toMetadata);
  }

  async write(organizationId: string, name: string, value: string, description?: string): Promise<SecretMetadata> {
    assertValidSecretName(name);
    if (value.length === 0) throw new Error("Secret value must not be empty");
    if (value.length > 64 * 1024) throw new Error("Secret value exceeds 64 KiB");

    const now = this.clock().toISOString();
    const existing = await this.store.getSecret(organizationId, name);
    const record = await this.store.upsertSecret({
      organizationId,
      name,
      ...(description !== undefined ? { description } : existing?.description !== undefined ? { description: existing.description } : {}),
      backend: "managed",
      ciphertext: encryptSecret(value, deriveDataKey(this.masterKey, organizationId), `${organizationId}:${name}`),
      fingerprint: secretFingerprint(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return toMetadata(record);
  }

  async delete(organizationId: string, name: string): Promise<boolean> {
    return this.store.deleteSecret(organizationId, name);
  }
}

function toMetadata(record: SecretRecord): SecretMetadata {
  const { organizationId: _org, ciphertext: _ct, externalUri: _uri, ...metadata } = record;
  return metadata;
}

export function envVarName(name: string): string {
  return `DATAFLOW_SECRET_${name.replace(/[.-]/g, "_").toUpperCase()}`;
}

/**
 * Reads secrets from the process environment. Useful for self-hosted single-tenant
 * deployments and for CI, where an external secret manager already injects values.
 */
export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async read(_organizationId: string, name: string): Promise<string> {
    assertValidSecretName(name);
    const value = this.env[envVarName(name)];
    if (value === undefined) throw new SecretNotFoundError(name);
    return value;
  }

  async describe(_organizationId: string, name: string): Promise<SecretMetadata | null> {
    const value = this.env[envVarName(name)];
    if (value === undefined) return null;
    return {
      name,
      backend: "environment",
      fingerprint: secretFingerprint(value),
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
  }

  async list(): Promise<SecretMetadata[]> {
    return Object.keys(this.env)
      .filter((k) => k.startsWith("DATAFLOW_SECRET_"))
      .map((k) => ({
        name: k.slice("DATAFLOW_SECRET_".length).toLowerCase(),
        backend: "environment" as const,
        fingerprint: secretFingerprint(this.env[k] ?? ""),
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      }));
  }

  async write(): Promise<SecretMetadata> {
    throw new Error("Environment secrets are read-only; set the variable in your deployment instead");
  }

  async delete(): Promise<boolean> {
    throw new Error("Environment secrets are read-only");
  }
}

/** Tries each provider in order. First hit wins. */
export class CompositeSecretProvider implements SecretProvider {
  constructor(private readonly providers: SecretProvider[]) {
    if (!providers.length) throw new Error("CompositeSecretProvider requires at least one provider");
  }

  async read(organizationId: string, name: string): Promise<string> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.read(organizationId, name);
      } catch (error) {
        if (!(error instanceof SecretNotFoundError)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new SecretNotFoundError(name);
  }

  async describe(organizationId: string, name: string): Promise<SecretMetadata | null> {
    for (const provider of this.providers) {
      const metadata = await provider.describe(organizationId, name);
      if (metadata) return metadata;
    }
    return null;
  }

  async list(organizationId: string): Promise<SecretMetadata[]> {
    const seen = new Map<string, SecretMetadata>();
    for (const provider of this.providers) {
      for (const metadata of await provider.list(organizationId)) {
        if (!seen.has(metadata.name)) seen.set(metadata.name, metadata);
      }
    }
    return [...seen.values()];
  }

  async write(organizationId: string, name: string, value: string, description?: string): Promise<SecretMetadata> {
    return this.providers[0]!.write(organizationId, name, value, description);
  }

  async delete(organizationId: string, name: string): Promise<boolean> {
    return this.providers[0]!.delete(organizationId, name);
  }
}
