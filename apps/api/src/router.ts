import type { Store } from "@dataflow-studio/database";
import type { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, metrics, newRequestId, rootLogger } from "@dataflow-studio/observability";
import type { SecretProvider } from "@dataflow-studio/secrets";
import { listNodeTypes } from "@dataflow-studio/workflow-engine";
import type { AuthProvider } from "./auth.js";
import { createContext, type ApiContext } from "./context.js";
import { ApiError, toEnvelope } from "./errors.js";
import { permissionsFor } from "./rbac.js";
import { enforceRateLimit, MemoryRateLimiter, RATE_LIMITS, type RateLimiter, type RateLimitRule } from "./rate-limit.js";
import * as services from "./services/index.js";

export interface RouteRequest {
  context: ApiContext;
  params: Record<string, string>;
  query: URLSearchParams;
  request: Request;
  body: <T = Record<string, unknown>>() => Promise<T>;
}

type Handler = (input: RouteRequest) => Promise<unknown> | unknown;

interface Route {
  method: string;
  /** `/api/v1/pipelines/:id/runs` */
  pattern: string;
  handler: Handler;
  /** Rate-limit bucket. Defaults to `default`. */
  limit?: keyof typeof RATE_LIMITS;
  /** Handlers that build their own Response (SSE, file downloads). */
  raw?: boolean;
  /** Responds 201 instead of 200. Declared per route rather than guessed. */
  created?: boolean;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const number = (value: string | null): number | undefined => (value === null || value === "" ? undefined : Number(value));

/** Reads and validates a JSON body once, with a size cap. */
function bodyReader(request: Request): <T>() => Promise<T> {
  let cached: unknown;
  let read = false;
  return async <T>(): Promise<T> => {
    if (read) return cached as T;
    read = true;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      throw new ApiError("payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const type = request.headers.get("content-type") ?? "";
    if (request.method !== "GET" && request.method !== "DELETE" && type && !type.includes("application/json")) {
      throw new ApiError("unsupported_media_type", `Expected application/json, got "${type}"`);
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new ApiError("payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    if (!text) { cached = {}; return cached as T; }
    try {
      cached = JSON.parse(text);
    } catch (error) {
      throw ApiError.validation(`Request body is not valid JSON: ${(error as Error).message}`);
    }
    if (cached === null || typeof cached !== "object" || Array.isArray(cached)) {
      throw ApiError.validation("Request body must be a JSON object");
    }
    return cached as T;
  };
}

const routes: Route[] = [
  // ------------------------------------------------------------------ meta
  { method: "GET", pattern: "/api/v1/me", handler: ({ context }) => ({
      userId: context.principal.userId,
      organizationId: context.principal.organizationId,
      role: context.principal.role,
      actorType: context.principal.actorType,
      permissions: permissionsFor(context.principal.role),
      storeDriver: context.store.driver,
    }) },
  { method: "GET", pattern: "/api/v1/node-types", handler: () => ({ items: listNodeTypes() }) },
  { method: "GET", pattern: "/api/v1/templates", handler: () => ({ items: services.demo.listTemplates() }) },

  // ------------------------------------------------------------- pipelines
  { method: "GET", pattern: "/api/v1/pipelines", handler: ({ context, query }) =>
      services.pipelines.listPipelines(context, {
        limit: number(query.get("limit")),
        ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.get("search") ? { search: query.get("search")! } : {}),
        ...(query.get("tag") ? { tag: query.get("tag")! } : {}),
        includeArchived: query.get("includeArchived") === "true",
      }) },
  { method: "POST", pattern: "/api/v1/pipelines", created: true, limit: "write", handler: async ({ context, body }) =>
      services.pipelines.createPipeline(context, await body()) },
  { method: "GET", pattern: "/api/v1/pipelines/:id", handler: ({ context, params }) =>
      services.pipelines.getPipeline(context, params["id"]!) },
  { method: "PATCH", pattern: "/api/v1/pipelines/:id", limit: "write", handler: async ({ context, params, body }) =>
      services.pipelines.updatePipeline(context, params["id"]!, await body()) },
  { method: "DELETE", pattern: "/api/v1/pipelines/:id", limit: "write", handler: ({ context, params }) =>
      services.pipelines.deletePipeline(context, params["id"]!) },
  { method: "POST", pattern: "/api/v1/pipelines/:id/validate", handler: ({ context, params }) =>
      services.pipelines.validatePipelineDefinition(context, { pipelineId: params["id"]! }) },
  { method: "POST", pattern: "/api/v1/validate", handler: async ({ context, body }) =>
      services.pipelines.validatePipelineDefinition(context, { definition: (await body<{ definition: unknown }>()).definition }) },
  { method: "POST", pattern: "/api/v1/pipelines/:id/publish", limit: "write", handler: async ({ context, params, body }) =>
      services.pipelines.publishPipeline(context, params["id"]!, await body()) },
  { method: "POST", pattern: "/api/v1/pipelines/:id/run", limit: "execute", handler: async ({ context, params, body }) =>
      services.pipelines.runPipeline(context, params["id"]!, await body()) },
  { method: "GET", pattern: "/api/v1/pipelines/:id/runs", handler: ({ context, params, query }) =>
      services.runs.listRuns(context, {
        pipelineId: params["id"]!,
        limit: number(query.get("limit")),
        ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.get("state") ? { state: query.getAll("state") } : {}),
      }) },
  { method: "GET", pattern: "/api/v1/pipelines/:id/compare", handler: ({ context, params, query }) =>
      services.pipelines.comparePipelineVersions(
        context, params["id"]!, Number(query.get("from") ?? 1), Number(query.get("to") ?? 2),
      ) },
  { method: "POST", pattern: "/api/v1/pipelines/from-template", created: true, limit: "write", handler: async ({ context, body }) =>
      services.demo.createFromTemplate(context, await body()) },

  // ------------------------------------------------------------------ runs
  { method: "GET", pattern: "/api/v1/runs", handler: ({ context, query }) =>
      services.runs.listRuns(context, {
        limit: number(query.get("limit")),
        ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.get("pipelineId") ? { pipelineId: query.get("pipelineId")! } : {}),
        ...(query.getAll("state").length ? { state: query.getAll("state") } : {}),
        ...(query.get("trigger") ? { trigger: query.get("trigger")! } : {}),
        ...(query.get("backfillId") ? { backfillId: query.get("backfillId")! } : {}),
        ...(query.get("since") ? { since: query.get("since")! } : {}),
      }) },
  { method: "GET", pattern: "/api/v1/runs/:id", handler: ({ context, params }) =>
      services.runs.getRun(context, params["id"]!) },
  { method: "POST", pattern: "/api/v1/runs/:id/cancel", limit: "write", handler: ({ context, params }) =>
      services.runs.cancelRun(context, params["id"]!) },
  { method: "POST", pattern: "/api/v1/runs/:id/retry", limit: "execute", handler: async ({ context, params, body }) =>
      services.runs.retryRun(context, params["id"]!, await body()) },
  { method: "GET", pattern: "/api/v1/runs/:id/logs", handler: ({ context, params, query }) =>
      services.runs.listRunLogs(context, params["id"]!, {
        limit: number(query.get("limit")),
        ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.get("taskRunId") ? { taskRunId: query.get("taskRunId")! } : {}),
        ...(query.get("level") ? { level: query.get("level") as "info" } : {}),
        ...(query.get("search") ? { search: query.get("search")! } : {}),
      }) },
  { method: "GET", pattern: "/api/v1/runs/:id/tasks/:taskId", handler: ({ context, params }) =>
      services.runs.getTask(context, params["id"]!, params["taskId"]!) },
  { method: "POST", pattern: "/api/v1/runs/:id/tasks/:taskId/cancel", limit: "write", handler: ({ context, params }) =>
      services.runs.cancelTask(context, params["id"]!, params["taskId"]!) },
  { method: "GET", pattern: "/api/v1/runs/:id/investigate", handler: ({ context, params }) =>
      services.runs.investigateRun(context, params["id"]!) },
  { method: "GET", pattern: "/api/v1/runs/:id/events", raw: true, handler: ({ context, params, request }) =>
      services.runs.streamRunEvents(context, params["id"]!, {
        ...(request.headers.get("last-event-id") ? { lastEventId: Number(request.headers.get("last-event-id")) } : {}),
        signal: request.signal,
      }) },

  // ------------------------------------------------------------ connections
  { method: "GET", pattern: "/api/v1/connections", handler: ({ context }) => services.connections.listConnections(context) },
  { method: "POST", pattern: "/api/v1/connections", created: true, limit: "write", handler: async ({ context, body }) =>
      services.connections.createConnection(context, await body()) },
  { method: "GET", pattern: "/api/v1/connections/:id", handler: ({ context, params }) =>
      services.connections.getConnection(context, params["id"]!) },
  { method: "PATCH", pattern: "/api/v1/connections/:id", limit: "write", handler: async ({ context, params, body }) =>
      services.connections.updateConnection(context, params["id"]!, await body()) },
  { method: "DELETE", pattern: "/api/v1/connections/:id", limit: "write", handler: ({ context, params }) =>
      services.connections.deleteConnection(context, params["id"]!) },
  { method: "POST", pattern: "/api/v1/connections/:id/test", limit: "write", handler: ({ context, params }) =>
      services.connections.testConnection(context, params["id"]!) },

  // ---------------------------------------------------------------- secrets
  { method: "GET", pattern: "/api/v1/secrets", handler: ({ context }) => services.secrets.listSecrets(context) },
  { method: "POST", pattern: "/api/v1/secrets", created: true, limit: "write", handler: async ({ context, body }) =>
      services.secrets.createSecret(context, await body()) },
  { method: "DELETE", pattern: "/api/v1/secrets/:name", limit: "write", handler: ({ context, params }) =>
      services.secrets.deleteSecret(context, decodeURIComponent(params["name"]!)) },

  // -------------------------------------------------------------- schedules
  { method: "GET", pattern: "/api/v1/schedules", handler: ({ context, query }) =>
      services.schedules.listSchedules(context, query.get("pipelineId") ?? undefined) },
  { method: "POST", pattern: "/api/v1/schedules", created: true, limit: "write", handler: async ({ context, body }) =>
      services.schedules.createSchedule(context, await body()) },
  { method: "PATCH", pattern: "/api/v1/schedules/:id", limit: "write", handler: async ({ context, params, body }) =>
      services.schedules.updateSchedule(context, params["id"]!, await body()) },
  { method: "DELETE", pattern: "/api/v1/schedules/:id", limit: "write", handler: ({ context, params }) =>
      services.schedules.deleteSchedule(context, params["id"]!) },

  // -------------------------------------------------------------- backfills
  { method: "GET", pattern: "/api/v1/backfills", handler: ({ context, query }) =>
      services.schedules.listBackfills(context, query.get("pipelineId") ?? undefined) },
  { method: "POST", pattern: "/api/v1/backfills", created: true, limit: "execute", handler: async ({ context, body }) =>
      services.schedules.createBackfill(context, await body()) },
  { method: "GET", pattern: "/api/v1/backfills/:id", handler: ({ context, params }) =>
      services.schedules.getBackfill(context, params["id"]!) },
  { method: "POST", pattern: "/api/v1/backfills/:id/state", limit: "write", handler: async ({ context, params, body }) =>
      services.schedules.setBackfillState(context, params["id"]!, (await body<{ state: "paused" }>()).state) },

  // ---------------------------------------------------------------- catalog
  { method: "GET", pattern: "/api/v1/datasets", handler: ({ context, query }) =>
      services.catalog.listDatasets(context, {
        limit: number(query.get("limit")),
        ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.get("search") ? { search: query.get("search")! } : {}),
      }) },
  { method: "GET", pattern: "/api/v1/datasets/:name", handler: ({ context, params }) =>
      services.catalog.getDataset(context, decodeURIComponent(params["name"]!)) },
  { method: "GET", pattern: "/api/v1/lineage", handler: ({ context, query }) =>
      services.catalog.organizationLineage(context, query.get("pipelineId") ?? undefined) },
  { method: "GET", pattern: "/api/v1/incidents", handler: ({ context, query }) =>
      services.catalog.listIncidents(context, {
        limit: number(query.get("limit")),
        ...(query.get("status") ? { status: query.get("status") as "open" } : {}),
        ...(query.get("kind") ? { kind: query.get("kind") as "repeated_failure" } : {}),
      }) },
  { method: "PATCH", pattern: "/api/v1/incidents/:id", limit: "write", handler: async ({ context, params, body }) =>
      services.catalog.updateIncident(context, params["id"]!, await body()) },
  { method: "GET", pattern: "/api/v1/search", handler: ({ context, query }) =>
      services.catalog.search(context, query.get("q") ?? "", number(query.get("limit")) ?? 20).then((items) => ({ items })) },

  // -------------------------------------------------------------- analytics
  { method: "GET", pattern: "/api/v1/dashboard", handler: ({ context, query }) =>
      services.analytics.getDashboard(context, { days: number(query.get("days")) }) },
  { method: "GET", pattern: "/api/v1/analytics", handler: ({ context, query }) =>
      services.analytics.getAnalytics(context, {
        ...(query.get("from") ? { from: query.get("from")! } : {}),
        ...(query.get("to") ? { to: query.get("to")! } : {}),
        ...(query.get("pipelineId") ? { pipelineId: query.get("pipelineId")! } : {}),
      }) },
  { method: "GET", pattern: "/api/v1/audit", handler: ({ context, query }) =>
      services.analytics.listAudit(context, {
        limit: number(query.get("limit")),
        ...(query.get("action") ? { action: query.get("action")! } : {}),
        ...(query.get("resourceType") ? { resourceType: query.get("resourceType")! } : {}),
      }) },

  // ---------------------------------------------------------------- preview
  { method: "POST", pattern: "/api/v1/preview/source", limit: "execute", handler: async ({ context, body }) =>
      services.preview.previewSource(context, await body()) },
  { method: "POST", pattern: "/api/v1/preview/sql", handler: async ({ context, body }) =>
      services.preview.previewSql(context, await body()) },
  { method: "POST", pattern: "/api/v1/preview/quality", handler: async ({ context, body }) =>
      services.preview.previewQuality(context, await body()) },

  // --------------------------------------------------------------- api keys
  { method: "GET", pattern: "/api/v1/api-keys", handler: ({ context }) => services.apiKeys.listApiKeys(context) },
  { method: "POST", pattern: "/api/v1/api-keys", created: true, limit: "write", handler: async ({ context, body }) =>
      services.apiKeys.createApiKey(context, await body()) },
  { method: "DELETE", pattern: "/api/v1/api-keys/:id", limit: "write", handler: ({ context, params }) =>
      services.apiKeys.revokeApiKey(context, params["id"]!) },

  // ------------------------------------------------------------------- demo
  { method: "POST", pattern: "/api/v1/demo/seed", created: true, limit: "execute", handler: async ({ context, body }) =>
      services.demo.seedDemoData(context, await body()) },
];

interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(method: string, pathname: string): MatchedRoute | null {
  const segments = pathname.replace(/\/+$/, "").split("/");
  let methodMismatch = false;

  for (const route of routes) {
    const pattern = route.pattern.split("/");
    if (pattern.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      const expected = pattern[i]!;
      const actual = segments[i]!;
      if (expected.startsWith(":")) {
        if (!actual) { matched = false; break; }
        params[expected.slice(1)] = actual;
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (route.method !== method) { methodMismatch = true; continue; }
    return { route, params };
  }
  if (methodMismatch) throw new ApiError("method_not_allowed", `${method} is not allowed on ${pathname}`);
  return null;
}

export interface ApiHandlerOptions {
  store: Store;
  engine: ExecutionEngine;
  secrets: SecretProvider;
  auth: AuthProvider;
  rateLimiter?: RateLimiter;
  logger?: Logger;
  clock?: () => Date;
}

/**
 * The single entry point for the REST API.
 *
 * Next.js route handlers, the standalone server and the tests all call this, so
 * authentication, rate limiting, request ids, audit and the error envelope are
 * applied uniformly and cannot be forgotten per route.
 */
export function createApiHandler(options: ApiHandlerOptions): (request: Request) => Promise<Response> {
  const limiter = options.rateLimiter ?? new MemoryRateLimiter();
  const logger = options.logger ?? rootLogger;
  const clock = options.clock ?? (() => new Date());

  return async function handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? newRequestId();
    const url = new URL(request.url);
    const startedAt = Date.now();

    const respond = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": requestId,
          "cache-control": "no-store",
          ...extraHeaders,
        },
      });

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { allow: "GET,POST,PATCH,DELETE,OPTIONS", "x-request-id": requestId } });
      }
      if (url.pathname === "/api/v1/health") {
        return respond(200, { ok: true, driver: options.store.driver, time: clock().toISOString() });
      }

      const matched = matchRoute(request.method, url.pathname);
      if (!matched) throw ApiError.notFound("Endpoint", url.pathname);

      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? undefined;
      const principal = await options.auth.authenticate(request, options.store);
      if (!principal) {
        // Rate-limit anonymous probes by IP so an open endpoint cannot be hammered.
        await enforceRateLimit(limiter, `anon:${ip ?? "unknown"}`, RATE_LIMITS.anonymous);
        throw ApiError.unauthenticated();
      }

      const rule: RateLimitRule = RATE_LIMITS[matched.route.limit ?? "default"];
      const limitResult = await enforceRateLimit(
        limiter,
        `${principal.organizationId}:${principal.userId}:${matched.route.limit ?? "default"}`,
        rule,
      );

      const context = createContext({
        store: options.store,
        engine: options.engine,
        secrets: options.secrets,
        principal,
        requestId,
        ...(ip ? { ip } : {}),
        logger,
        now: clock(),
      });

      const result = await matched.route.handler({
        context,
        params: matched.params,
        query: url.searchParams,
        request,
        body: bodyReader(request),
      });

      metrics.increment("dataflow_api_requests_total", { route: matched.route.pattern, method: request.method, status: "2xx" });
      metrics.observe("dataflow_api_duration_seconds", (Date.now() - startedAt) / 1000, { route: matched.route.pattern });

      if (matched.route.raw) return result as Response;
      if (result === undefined) return respond(204, null);
      return respond(matched.route.created ? 201 : 200, result, {
        "x-ratelimit-limit": String(rule.limit),
        "x-ratelimit-remaining": String(limitResult.remaining),
      });
    } catch (error) {
      const envelope = toEnvelope(error, requestId);
      if (envelope.status >= 500) {
        logger.error("API request failed", { requestId, path: url.pathname, error: (error as Error).message, stack: (error as Error).stack });
      } else {
        logger.info("API request rejected", { requestId, path: url.pathname, status: envelope.status, code: envelope.body.error.code });
      }
      metrics.increment("dataflow_api_requests_total", {
        route: url.pathname,
        method: request.method,
        status: `${Math.floor(envelope.status / 100)}xx`,
      });
      const headers: Record<string, string> = {};
      if (envelope.status === 429) {
        const retryAfter = (envelope.body.error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (retryAfter) headers["retry-after"] = String(retryAfter);
      }
      return respond(envelope.status, envelope.body, headers);
    }
  };
}

export function listRoutes(): Array<{ method: string; pattern: string }> {
  return routes.map(({ method, pattern }) => ({ method, pattern }));
}
