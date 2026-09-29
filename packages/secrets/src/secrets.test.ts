import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  constantTimeEquals, decryptSecret, deriveDataKey, encryptSecret,
  EncryptionKeyError, loadMasterKey, secretFingerprint,
} from "./crypto.js";
import {
  assertValidSecretName, CompositeSecretProvider, EnvironmentSecretProvider,
  ManagedSecretProvider, SecretAccessDeniedError, SecretNotFoundError,
  envVarName, type SecretRecord, type SecretRecordStore,
} from "./provider.js";
import { collectReferences, maskConfig, resolveSecrets } from "./resolve.js";

const MASTER = randomBytes(32);

class MemorySecretStore implements SecretRecordStore {
  readonly rows = new Map<string, SecretRecord>();
  private key(org: string, name: string) { return `${org}/${name}`; }
  async getSecret(org: string, name: string) { return this.rows.get(this.key(org, name)) ?? null; }
  async listSecrets(org: string) { return [...this.rows.values()].filter((r) => r.organizationId === org); }
  async upsertSecret(record: SecretRecord) { this.rows.set(this.key(record.organizationId, record.name), record); return record; }
  async deleteSecret(org: string, name: string) { return this.rows.delete(this.key(org, name)); }
}

describe("loadMasterKey", () => {
  it("accepts a 32-byte base64 key", () => {
    expect(loadMasterKey(MASTER.toString("base64")).length).toBe(32);
  });
  it("accepts a 64-char hex key", () => {
    expect(loadMasterKey(MASTER.toString("hex")).length).toBe(32);
  });
  it("rejects a missing key", () => {
    // loadMasterKey falls back to process.env.ENCRYPTION_KEY when the argument is
    // undefined, so the "missing" case has to be asserted with that variable
    // genuinely absent - otherwise the assertion passes or fails depending on
    // whoever exported a key into the shell or the CI job.
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => loadMasterKey(undefined)).toThrow(EncryptionKeyError);
      expect(() => loadMasterKey("")).toThrow(EncryptionKeyError);
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previous;
    }
  });
  it("rejects a short key rather than padding it", () => {
    expect(() => loadMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("envelope encryption", () => {
  it("round-trips a value", () => {
    const key = deriveDataKey(MASTER, "org_1");
    const sealed = encryptSecret("hunter2", key, "org_1:pg");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("hunter2");
    expect(decryptSecret(sealed, key, "org_1:pg")).toBe("hunter2");
  });

  it("produces a different ciphertext each time", () => {
    const key = deriveDataKey(MASTER, "org_1");
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("derives a distinct key per organization", () => {
    expect(deriveDataKey(MASTER, "org_1").equals(deriveDataKey(MASTER, "org_2"))).toBe(false);
  });

  it("refuses to decrypt another organization's ciphertext", () => {
    const sealed = encryptSecret("cross-tenant", deriveDataKey(MASTER, "org_1"), "org_1:pg");
    expect(() => decryptSecret(sealed, deriveDataKey(MASTER, "org_2"), "org_2:pg")).toThrow();
  });

  it("detects tampering with the ciphertext", () => {
    const key = deriveDataKey(MASTER, "org_1");
    const sealed = encryptSecret("value", key);
    const parts = sealed.split(":");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });

  it("detects a changed AAD", () => {
    const key = deriveDataKey(MASTER, "org_1");
    const sealed = encryptSecret("value", key, "org_1:name-a");
    expect(() => decryptSecret(sealed, key, "org_1:name-b")).toThrow();
  });

  it("rejects an unknown envelope version", () => {
    expect(() => decryptSecret("v9:a:b:c", deriveDataKey(MASTER, "o"))).toThrow(/envelope format/);
  });

  it("fingerprints deterministically without revealing the value", () => {
    expect(secretFingerprint("abc")).toBe(secretFingerprint("abc"));
    expect(secretFingerprint("abc")).not.toContain("abc");
    expect(secretFingerprint("abc")).not.toBe(secretFingerprint("abd"));
  });

  it("compares in constant time", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});

describe("ManagedSecretProvider", () => {
  const setup = () => {
    const store = new MemorySecretStore();
    return { store, provider: new ManagedSecretProvider(store, MASTER) };
  };

  it("writes and reads a secret", async () => {
    const { provider } = setup();
    await provider.write("org_1", "prod-postgres-password", "s3cret", "prod db");
    expect(await provider.read("org_1", "prod-postgres-password")).toBe("s3cret");
  });

  it("never exposes the ciphertext through metadata", async () => {
    const { provider } = setup();
    const metadata = await provider.write("org_1", "token", "value");
    expect(JSON.stringify(metadata)).not.toContain("value");
    expect(metadata).not.toHaveProperty("ciphertext");
    expect((await provider.list("org_1")).every((m) => !("ciphertext" in m))).toBe(true);
  });

  it("isolates organizations", async () => {
    const { provider } = setup();
    await provider.write("org_1", "token", "org-1-value");
    await expect(provider.read("org_2", "token")).rejects.toThrow(SecretNotFoundError);
    expect(await provider.list("org_2")).toEqual([]);
  });

  it("preserves createdAt across updates", async () => {
    const { provider } = setup();
    const first = await provider.write("org_1", "t", "a");
    await new Promise((r) => setTimeout(r, 2));
    const second = await provider.write("org_1", "t", "b");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await provider.read("org_1", "t")).toBe("b");
  });

  it("rejects invalid names and empty values", async () => {
    const { provider } = setup();
    await expect(provider.write("org_1", "bad name!", "x")).rejects.toThrow(/Invalid secret name/);
    await expect(provider.write("org_1", "ok", "")).rejects.toThrow(/must not be empty/);
    expect(() => assertValidSecretName("../etc/passwd")).toThrow();
  });

  it("deletes a secret", async () => {
    const { provider } = setup();
    await provider.write("org_1", "t", "a");
    expect(await provider.delete("org_1", "t")).toBe(true);
    await expect(provider.read("org_1", "t")).rejects.toThrow(SecretNotFoundError);
  });

  it("reads an environment-backed record from the environment", async () => {
    const { store, provider } = setup();
    process.env[envVarName("ci-token")] = "from-env";
    await store.upsertSecret({
      organizationId: "org_1", name: "ci-token", backend: "environment",
      fingerprint: "x", createdAt: "", updatedAt: "",
    });
    expect(await provider.read("org_1", "ci-token")).toBe("from-env");
    delete process.env[envVarName("ci-token")];
  });

  it("explains that an external reference needs a provider", async () => {
    const { store, provider } = setup();
    await store.upsertSecret({
      organizationId: "org_1", name: "vault-token", backend: "external",
      externalUri: "vault://kv/prod#token", fingerprint: "x", createdAt: "", updatedAt: "",
    });
    await expect(provider.read("org_1", "vault-token")).rejects.toThrow(/external secret provider/);
  });
});

describe("EnvironmentSecretProvider", () => {
  it("reads and lists from the environment", async () => {
    const provider = new EnvironmentSecretProvider({ DATAFLOW_SECRET_API_TOKEN: "abc" });
    expect(await provider.read("org_1", "api_token")).toBe("abc");
    expect((await provider.list("org_1")).map((m) => m.name)).toEqual(["api_token"]);
  });

  it("is read-only", async () => {
    const provider = new EnvironmentSecretProvider({});
    await expect(provider.write("o", "n", "v")).rejects.toThrow(/read-only/);
    await expect(provider.delete("o", "n")).rejects.toThrow(/read-only/);
  });
});

describe("CompositeSecretProvider", () => {
  it("falls through to the next provider on a miss", async () => {
    const store = new MemorySecretStore();
    const managed = new ManagedSecretProvider(store, MASTER);
    await managed.write("org_1", "managed-only", "m");
    const composite = new CompositeSecretProvider([
      managed,
      new EnvironmentSecretProvider({ DATAFLOW_SECRET_ENV_ONLY: "e" }),
    ]);
    expect(await composite.read("org_1", "managed-only")).toBe("m");
    expect(await composite.read("org_1", "env_only")).toBe("e");
    await expect(composite.read("org_1", "nowhere")).rejects.toThrow(SecretNotFoundError);
  });
});

describe("resolveSecrets", () => {
  const provider = new EnvironmentSecretProvider({
    DATAFLOW_SECRET_PG_PASSWORD: "pg-pass",
    DATAFLOW_SECRET_API_TOKEN: "Bearer xyz",
  });

  it("replaces nested references and reports what it read", async () => {
    const config = {
      host: "db.internal",
      password: { secretRef: "pg_password" },
      headers: { Authorization: { secretRef: "api_token" } },
      list: [{ secretRef: "pg_password" }],
    };
    const result = await resolveSecrets(config, { organizationId: "org_1", provider });
    expect(result.value).toEqual({
      host: "db.internal",
      password: "pg-pass",
      headers: { Authorization: "Bearer xyz" },
      list: ["pg-pass"],
    });
    expect(result.resolved.sort()).toEqual(["api_token", "pg_password"]);
  });

  it("does not mutate the input", async () => {
    const config = { password: { secretRef: "pg_password" } };
    await resolveSecrets(config, { organizationId: "org_1", provider });
    expect(config.password).toEqual({ secretRef: "pg_password" });
  });

  it("enforces the authorization hook", async () => {
    await expect(
      resolveSecrets({ password: { secretRef: "pg_password" } }, {
        organizationId: "org_1",
        provider,
        authorize: (name) => name !== "pg_password",
      }),
    ).rejects.toThrow(SecretAccessDeniedError);
  });

  it("surfaces a missing secret as an error rather than undefined", async () => {
    await expect(
      resolveSecrets({ x: { secretRef: "absent" } }, { organizationId: "org_1", provider }),
    ).rejects.toThrow(SecretNotFoundError);
  });
});

describe("maskConfig", () => {
  it("replaces references with a masked marker", () => {
    expect(maskConfig({ password: { secretRef: "pg" }, host: "db" })).toEqual({
      password: { secretRef: "pg", masked: true },
      host: "db",
    });
  });

  it("walks arrays and nested objects", () => {
    const masked = maskConfig({ headers: { a: { secretRef: "t" } }, many: [{ secretRef: "u" }] });
    expect(JSON.stringify(masked)).toContain('"masked":true');
  });
});

describe("collectReferences", () => {
  it("finds every reference", () => {
    expect([...collectReferences({ a: { secretRef: "x" }, b: [{ secretRef: "y" }, 1], c: "z" })].sort())
      .toEqual(["x", "y"]);
  });
});
