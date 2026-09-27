import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ConnectorError } from "./types.js";

/**
 * Egress policy for user-configured URLs.
 *
 * A pipeline node is, by definition, a URL supplied by a user and fetched by our
 * infrastructure - which is the textbook SSRF setup. The policy is deny-by-default
 * for anything that is not clearly on the public internet, plus an optional
 * allowlist for deployments that want to be stricter still.
 */
export interface EgressPolicy {
  /** Hostname suffixes that are permitted. Empty means "any public host". */
  allowedHosts?: readonly string[];
  /** Hostname suffixes that are always rejected, checked before the allowlist. */
  blockedHosts?: readonly string[];
  allowedSchemes?: readonly string[];
  allowedPorts?: readonly number[];
  /** Escape hatch for local development against a dev API. Never enable in production. */
  allowPrivateNetworks?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export const DEFAULT_EGRESS_POLICY: Required<Omit<EgressPolicy, "allowedHosts" | "blockedHosts">> & EgressPolicy = {
  allowedSchemes: ["https:", "http:"],
  allowedPorts: [80, 443, 8080, 8443],
  allowPrivateNetworks: false,
  maxRedirects: 3,
  maxResponseBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
};

export class SsrfBlockedError extends ConnectorError {
  constructor(message: string) {
    super(message, "permission");
    this.name = "SsrfBlockedError";
  }
}

/** IPv4/IPv6 ranges that must never be reachable from a pipeline. */
const BLOCKED_V4 = [
  { cidr: "0.0.0.0/8", label: "current network" },
  { cidr: "10.0.0.0/8", label: "private" },
  { cidr: "100.64.0.0/10", label: "carrier-grade NAT" },
  { cidr: "127.0.0.0/8", label: "loopback" },
  { cidr: "169.254.0.0/16", label: "link-local / cloud metadata" },
  { cidr: "172.16.0.0/12", label: "private" },
  { cidr: "192.0.0.0/24", label: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", label: "documentation" },
  { cidr: "192.168.0.0/16", label: "private" },
  { cidr: "198.18.0.0/15", label: "benchmarking" },
  { cidr: "198.51.100.0/24", label: "documentation" },
  { cidr: "203.0.113.0/24", label: "documentation" },
  { cidr: "224.0.0.0/4", label: "multicast" },
  { cidr: "240.0.0.0/4", label: "reserved" },
] as const;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split("/") as [string, string];
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export interface AddressVerdict {
  blocked: boolean;
  reason?: string;
}

export function classifyAddress(address: string): AddressVerdict {
  const version = isIP(address);
  if (version === 4) {
    for (const range of BLOCKED_V4) {
      if (inCidr(address, range.cidr)) {
        return { blocked: true, reason: `${address} is in ${range.cidr} (${range.label})` };
      }
    }
    return { blocked: false };
  }
  if (version === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "::" || normalized === "::1") {
      return { blocked: true, reason: `${address} is an IPv6 loopback or unspecified address` };
    }
    // fc00::/7 unique-local, fe80::/10 link-local, ::ffff:0:0/96 IPv4-mapped
    if (/^(f[cd]|fe[89ab])/.test(normalized)) {
      return { blocked: true, reason: `${address} is an IPv6 private or link-local address` };
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyAddress(mapped[1]!);
    return { blocked: false };
  }
  return { blocked: true, reason: `"${address}" is not a valid IP address` };
}

function hostMatches(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const pattern = suffix.toLowerCase().replace(/^\*?\.?/, "").replace(/\.$/, "");
  return host === pattern || host.endsWith(`.${pattern}`);
}

export interface ValidatedUrl {
  url: URL;
  /** Addresses the hostname resolved to, all of which passed the policy. */
  addresses: string[];
}

/**
 * Validates a URL against the policy, including DNS resolution. Resolving here
 * (and pinning the result for the request) is what stops a DNS-rebinding bypass:
 * a host that resolves to 169.254.169.254 is rejected before any socket opens.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  policy: EgressPolicy = {},
  resolver: (hostname: string) => Promise<string[]> = defaultResolver,
): Promise<ValidatedUrl> {
  const effective = { ...DEFAULT_EGRESS_POLICY, ...policy };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`"${rawUrl}" is not a valid absolute URL`);
  }

  if (!effective.allowedSchemes!.includes(url.protocol)) {
    throw new SsrfBlockedError(
      `Scheme "${url.protocol}" is not allowed. Allowed schemes: ${effective.allowedSchemes!.join(", ")}`,
    );
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("Credentials embedded in a URL are not allowed; use a secret reference in a header instead");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!effective.allowedPorts!.includes(port)) {
    throw new SsrfBlockedError(`Port ${port} is not allowed. Allowed ports: ${effective.allowedPorts!.join(", ")}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  for (const blocked of effective.blockedHosts ?? []) {
    if (hostMatches(hostname, blocked)) {
      throw new SsrfBlockedError(`Host "${hostname}" is on the deny list`);
    }
  }
  if (effective.allowedHosts?.length) {
    if (!effective.allowedHosts.some((allowed) => hostMatches(hostname, allowed))) {
      throw new SsrfBlockedError(
        `Host "${hostname}" is not on the connector allowlist. Allowed: ${effective.allowedHosts.join(", ")}`,
      );
    }
  }

  if (effective.allowPrivateNetworks) {
    return { url, addresses: [] };
  }

  // A literal IP needs no DNS, but still needs the range check.
  if (isIP(hostname)) {
    const verdict = classifyAddress(hostname);
    if (verdict.blocked) throw new SsrfBlockedError(`Blocked request to ${verdict.reason}`);
    return { url, addresses: [hostname] };
  }

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(hostname)) {
    throw new SsrfBlockedError(`Host "${hostname}" resolves inside the local network`);
  }

  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new ConnectorError(`Could not resolve "${hostname}": ${(error as Error).message}`, "connection", { cause: error });
  }
  if (!addresses.length) {
    throw new ConnectorError(`Host "${hostname}" did not resolve to any address`, "connection");
  }
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict.blocked) {
      throw new SsrfBlockedError(`Blocked request to "${hostname}": ${verdict.reason}`);
    }
  }
  return { url, addresses };
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Header names a pipeline may never set, because they let a request impersonate our own infrastructure. */
const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "x-forwarded-for", "x-forwarded-host", "x-real-ip",
  "metadata-flavor", "x-aws-ec2-metadata-token",
]);

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (!name || FORBIDDEN_HEADERS.has(name)) continue;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new ConnectorError(`Invalid header name "${rawName}"`, "configuration");
    }
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    // CRLF in a header value is request splitting.
    if (/[\r\n]/.test(value)) {
      throw new ConnectorError(`Header "${rawName}" contains a newline`, "configuration");
    }
    out[name] = value;
  }
  return out;
}

export function policyFromEnvironment(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const list = (value: string | undefined): string[] | undefined =>
    value ? value.split(",").map((v) => v.trim()).filter(Boolean) : undefined;
  const allowedHosts = list(env["CONNECTOR_ALLOWED_HOSTS"]);
  const blockedHosts = list(env["CONNECTOR_BLOCKED_HOSTS"]);
  return {
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(blockedHosts ? { blockedHosts } : {}),
    // Opt-in only, and only useful when a developer is pointing a node at localhost.
    allowPrivateNetworks: env["CONNECTOR_ALLOW_PRIVATE_NETWORKS"] === "true",
    ...(env["CONNECTOR_MAX_RESPONSE_BYTES"] ? { maxResponseBytes: Number(env["CONNECTOR_MAX_RESPONSE_BYTES"]) } : {}),
  };
}
