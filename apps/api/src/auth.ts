import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role, Store } from "@dataflow-studio/database";
import { newId } from "@dataflow-studio/observability";
import { ApiError } from "./errors.js";

export interface Principal {
  userId: string;
  organizationId: string;
  role: Role;
  actorType: "user" | "api_key" | "system";
  /** Set for API-key principals, so audit entries can name the key. */
  apiKeyId?: string;
  email?: string;
}

export const API_KEY_PREFIX = "dfs_";

/**
 * Creates an API key. The plaintext is returned exactly once; only its SHA-256 is
 * stored, so a database leak cannot be replayed against the API.
 */
export function generateApiKey(environment: "live" | "test" = "live"): { token: string; tokenHash: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${API_KEY_PREFIX}${environment}_${secret}`;
  return {
    token,
    tokenHash: hashApiKey(token),
    // Enough to identify a key in a list without being usable.
    prefix: token.slice(0, API_KEY_PREFIX.length + environment.length + 9),
  };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface AuthProvider {
  readonly name: string;
  /** Resolves a principal, or null when this provider does not apply. */
  authenticate(request: Request, store: Store): Promise<Principal | null>;
}

/** Authenticates `Authorization: Bearer dfs_live_...` against stored key hashes. */
export class ApiKeyAuthProvider implements AuthProvider {
  readonly name = "api-key";

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async authenticate(request: Request, store: Store): Promise<Principal | null> {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const token = match?.[1] ?? request.headers.get("x-api-key") ?? "";
    if (!token.startsWith(API_KEY_PREFIX)) return null;

    const record = await store.getApiKeyByHash(hashApiKey(token));
    if (!record || !safeEqualHex(record.tokenHash, hashApiKey(token))) {
      throw ApiError.unauthenticated("Invalid API key");
    }
    if (record.revokedAt) throw ApiError.unauthenticated("This API key has been revoked");
    if (record.expiresAt && new Date(record.expiresAt) < this.clock()) {
      throw ApiError.unauthenticated("This API key has expired");
    }
    await store.touchApiKey(record.id, this.clock().toISOString());
    return {
      userId: `key:${record.id}`,
      organizationId: record.organizationId,
      role: record.role,
      actorType: "api_key",
      apiKeyId: record.id,
    };
  }
}

export interface ClerkClaims {
  sub: string;
  org_id?: string;
  org_role?: string;
  org_slug?: string;
  email?: string;
}

/**
 * Bridges a Clerk session to a DataFlow principal.
 *
 * Verification is delegated to the host application: in Next.js the middleware
 * has already verified the session and `resolveClaims` reads it. Keeping the
 * verification outside this package means the API layer has no opinion about
 * which identity provider is in front of it - Clerk, Auth0 or an internal IdP all
 * satisfy the same interface.
 */
export class ClerkAuthProvider implements AuthProvider {
  readonly name = "clerk";

  constructor(private readonly resolveClaims: (request: Request) => Promise<ClerkClaims | null>) {}

  async authenticate(request: Request, store: Store): Promise<Principal | null> {
    const claims = await this.resolveClaims(request);
    if (!claims) return null;

    const organizationId = claims.org_id ?? request.headers.get("x-organization-id") ?? "";
    if (!organizationId) {
      throw ApiError.forbidden("Select an organization before calling the API");
    }
    const member = await store.getMember(organizationId, claims.sub);
    if (!member) {
      // The session is valid but this user is not a member: not a 401.
      throw ApiError.forbidden("You are not a member of that organization");
    }
    return {
      userId: claims.sub,
      organizationId,
      role: member.role,
      actorType: "user",
      ...(claims.email ? { email: claims.email } : member.email ? { email: member.email } : {}),
    };
  }
}

/**
 * Single-user provider for local development and self-hosting without an identity
 * provider. Enabled only when AUTH_MODE=local, and it says so on every page so
 * nobody ships it to production by accident.
 */
export class LocalAuthProvider implements AuthProvider {
  readonly name = "local";

  constructor(
    private readonly options: { userId?: string; organizationId?: string; role?: Role } = {},
  ) {}

  async authenticate(_request: Request, store: Store): Promise<Principal | null> {
    const userId = this.options.userId ?? process.env["LOCAL_USER_ID"] ?? "local-user";
    const organizationId = this.options.organizationId ?? process.env["LOCAL_ORGANIZATION_ID"] ?? "org_local";
    const role = this.options.role ?? "owner";

    if (!(await store.getOrganization(organizationId))) {
      await store.createOrganization({
        id: organizationId,
        name: "Local development",
        slug: "local",
        createdAt: new Date().toISOString(),
      });
    }
    if (!(await store.getMember(organizationId, userId))) {
      await store.upsertMember({ organizationId, userId, role, email: "local@localhost", createdAt: new Date().toISOString() });
    }
    return { userId, organizationId, role, actorType: "user", email: "local@localhost" };
  }
}

export class CompositeAuthProvider implements AuthProvider {
  readonly name = "composite";

  constructor(private readonly providers: readonly AuthProvider[]) {}

  async authenticate(request: Request, store: Store): Promise<Principal | null> {
    for (const provider of this.providers) {
      const principal = await provider.authenticate(request, store);
      if (principal) return principal;
    }
    return null;
  }
}

export function authProviderFromEnvironment(
  resolveClerkClaims?: (request: Request) => Promise<ClerkClaims | null>,
): AuthProvider {
  const providers: AuthProvider[] = [new ApiKeyAuthProvider()];
  const mode = process.env["AUTH_MODE"] ?? (process.env["CLERK_SECRET_KEY"] ? "clerk" : "local");

  if (mode === "clerk") {
    if (!resolveClerkClaims) {
      throw new Error("AUTH_MODE=clerk requires a Clerk claims resolver from the host application");
    }
    providers.push(new ClerkAuthProvider(resolveClerkClaims));
  } else if (mode === "local") {
    providers.push(new LocalAuthProvider());
  } else {
    throw new Error(`Unknown AUTH_MODE "${mode}". Supported: clerk, local.`);
  }
  return new CompositeAuthProvider(providers);
}

export function newApiKeyRecordId(): string {
  return newId("key");
}
