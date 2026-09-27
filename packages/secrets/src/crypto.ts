import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * Loads the master key. Accepts base64 or hex and requires 32 bytes: a short key
 * is a configuration error we refuse to paper over, because the result would be
 * a system that looks encrypted and is not.
 */
export function loadMasterKey(raw: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new EncryptionKeyError(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.",
    );
  }
  const candidate = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (candidate.length !== 32) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${candidate.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return candidate;
}

/**
 * Per-organization data key derived from the master key. One compromised
 * ciphertext cannot be replayed into another tenant's row, and the master key
 * itself never encrypts anything directly.
 */
export function deriveDataKey(masterKey: Buffer, organizationId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.from(organizationId, "utf8"), Buffer.from("dataflow-secret-v1"), 32),
  );
}

export interface EncryptedPayload {
  version: string;
  ciphertext: string;
}

/** `v1:<iv>:<tag>:<ciphertext>`, all base64. */
export function encryptSecret(plaintext: string, key: Buffer, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(encoded: string, key: Buffer, aad?: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Unsupported secret envelope format`);
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Non-reversible fingerprint, so the UI can show "unchanged" without decrypting. */
export function secretFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 16);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
