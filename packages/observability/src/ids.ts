import { randomUUID, randomBytes } from "node:crypto";

/**
 * Prefixed, sortable-ish identifiers. The prefix makes IDs self-describing in
 * logs and URLs, which matters a lot during an incident.
 */
export type IdPrefix =
  | "org" | "usr" | "pipe" | "ver" | "run" | "task" | "att"
  | "sch" | "bfl" | "conn" | "sec" | "ds" | "schema" | "qc" | "qr"
  | "inc" | "audit" | "key" | "req" | "wrk" | "lin" | "evt";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${Date.now().toString(36)}${out}`;
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function newWorkerId(): string {
  return `wrk_${process.pid.toString(36)}_${randomBytes(4).toString("hex")}`;
}
