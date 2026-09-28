import type { Store } from "@dataflow-studio/database";
import type { ExecutionEngine } from "@dataflow-studio/execution-engine";
import { Logger, newId, rootLogger } from "@dataflow-studio/observability";
import type { SecretProvider } from "@dataflow-studio/secrets";
import type { JsonObject } from "@dataflow-studio/workflow-engine";
import type { Principal } from "./auth.js";
import { requirePermission, type Permission } from "./rbac.js";

export interface ApiContext {
  store: Store;
  engine: ExecutionEngine;
  secrets: SecretProvider;
  principal: Principal;
  requestId: string;
  now: Date;
  logger: Logger;
  ip?: string;
}

export function createContext(input: Omit<ApiContext, "logger" | "now"> & { now?: Date; logger?: Logger }): ApiContext {
  return {
    ...input,
    now: input.now ?? new Date(),
    logger: (input.logger ?? rootLogger).child({
      requestId: input.requestId,
      organizationId: input.principal.organizationId,
    }),
  };
}

/** Authorize, then record. Every mutating service call goes through this pair. */
export function authorize(context: ApiContext, permission: Permission): void {
  requirePermission(context.principal.role, permission);
}

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  result?: "success" | "denied" | "error";
  metadata?: JsonObject;
}

export async function audit(context: ApiContext, input: AuditInput): Promise<void> {
  await context.store.appendAudit({
    id: newId("audit"),
    organizationId: context.principal.organizationId,
    actor: context.principal.apiKeyId ?? context.principal.userId,
    actorType: context.principal.actorType,
    action: input.action,
    resourceType: input.resourceType,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    result: input.result ?? "success",
    requestId: context.requestId,
    ...(context.ip ? { ip: context.ip } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: context.now.toISOString(),
  });
}

/** Runs the body, recording an audit entry whichever way it goes. */
export async function audited<T>(context: ApiContext, input: AuditInput, body: () => Promise<T>): Promise<T> {
  try {
    const result = await body();
    await audit(context, { ...input, result: "success" });
    return result;
  } catch (error) {
    await audit(context, {
      ...input,
      result: (error as { status?: number })?.status === 403 ? "denied" : "error",
      metadata: { ...(input.metadata ?? {}), error: (error as Error).message },
    }).catch(() => undefined);
    throw error;
  }
}
