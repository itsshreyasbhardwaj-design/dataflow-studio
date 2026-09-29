import { getRuntime } from "@dataflow-studio/api";
import { resolveClerkClaims } from "@/lib/server";

/**
 * Every REST route is served by one handler from @dataflow-studio/api, so the HTTP
 * surface, the SDK, the CLI and the server components all share one
 * implementation of authentication, RBAC, rate limiting and auditing.
 */
async function handle(request: Request): Promise<Response> {
  const runtime = await getRuntime({ resolveClerkClaims });
  return runtime.handler(request);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;

// Run events stream for as long as a run does, so this route must not be static.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
