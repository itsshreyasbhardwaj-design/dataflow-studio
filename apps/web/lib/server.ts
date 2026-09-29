import { headers } from "next/headers";
import { cache } from "react";
import { createContext, getRuntime, type ApiContext, type Principal } from "@dataflow-studio/api";

/**
 * Builds an API context for a server component.
 *
 * Server components call the same service functions the REST API calls, so a page
 * render does not make an HTTP request to itself, and permission checks are the
 * same code path in both. `cache` keeps it to one authentication per render.
 */
export const getServerContext = cache(async (): Promise<ApiContext> => {
  const runtime = await getRuntime({ resolveClerkClaims });
  const headerList = await headers();

  // Reconstruct a Request so one AuthProvider serves both HTTP routes and RSC.
  const request = new Request("http://internal/rsc", {
    headers: new Headers(Object.fromEntries(headerList.entries())),
  });
  const principal = await runtime.auth.authenticate(request, runtime.store);
  if (!principal) {
    throw new Error(
      "Not authenticated. In local mode this should not happen; with AUTH_MODE=clerk, sign in first.",
    );
  }

  return createContext({
    store: runtime.store,
    engine: runtime.engine,
    secrets: runtime.secrets,
    principal,
    requestId: headerList.get("x-request-id") ?? `req_rsc_${Math.random().toString(36).slice(2, 10)}`,
    logger: runtime.logger,
  });
});

export async function getPrincipal(): Promise<Principal> {
  return (await getServerContext()).principal;
}

/**
 * Reads Clerk session claims when Clerk is configured.
 *
 * Resolved through a dynamic import so `@clerk/nextjs` stays an optional
 * dependency: a self-hosted deployment running AUTH_MODE=local never needs it.
 */
async function resolveClerkClaims(_request: Request): Promise<{ sub: string; org_id?: string; org_role?: string; email?: string } | null> {
  if (process.env["AUTH_MODE"] !== "clerk") return null;
  try {
    const specifier = "@clerk/nextjs/server";
    const clerk = (await import(specifier)) as { auth: () => Promise<{ userId: string | null; orgId?: string | null; orgRole?: string | null }> };
    const session = await clerk.auth();
    if (!session.userId) return null;
    return {
      sub: session.userId,
      ...(session.orgId ? { org_id: session.orgId } : {}),
      ...(session.orgRole ? { org_role: session.orgRole } : {}),
    };
  } catch {
    throw new Error(
      'AUTH_MODE=clerk requires "@clerk/nextjs" to be installed. Run `pnpm add @clerk/nextjs` in apps/web, ' +
      "or set AUTH_MODE=local for a single-user deployment.",
    );
  }
}

export { resolveClerkClaims };
