import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4. Implemented here rather than pulled in as an SDK so
 * that the S3 connector works against any S3-compatible endpoint (MinIO, R2,
 * Backblaze, Ceph) with no vendor dependency and no transitive supply chain.
 */
export interface SigV4Input {
  method: string;
  url: URL;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  headers?: Record<string, string>;
  payload?: Buffer | string;
  now?: Date;
}

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** RFC 3986 encoding; S3 keys need `/` preserved in the path but encoded elsewhere. */
function uriEncode(value: string, preserveSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return preserveSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** The canonical request, exposed for debugging signature mismatches. */
  canonicalRequest: string;
  stringToSign: string;
}

export function signRequest(input: SigV4Input): SignedRequest {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = input.payload === undefined ? sha256Hex("") : sha256Hex(input.payload);

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalPath = input.url.pathname
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment), false))
    .join("/") || "/";

  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key, false), uriEncode(value, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}

export { UNSIGNED_PAYLOAD, sha256Hex };
