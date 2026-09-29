import type { Connection } from "@dataflow-studio/database";
import { ConnectorRegistry, type ConnectionResult } from "@dataflow-studio/connectors";
import { newId, redactString } from "@dataflow-studio/observability";
import { resolveSecrets } from "@dataflow-studio/secrets";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

const FAMILIES = ["postgres", "mysql", "http", "s3", "file"] as const;

/** Never returns a credential: `secretRefs` are names, `config` holds no secrets. */
export type PublicConnection = Connection;

export async function listConnections(context: ApiContext): Promise<PublicConnection[]> {
  authorize(context, "connection.read");
  return context.store.listConnections(context.principal.organizationId);
}

export async function getConnection(context: ApiContext, connectionId: string): Promise<PublicConnection> {
  authorize(context, "connection.read");
  const connection = await context.store.getConnection(context.principal.organizationId, connectionId);
  if (!connection) throw ApiError.notFound("Connection", connectionId);
  return connection;
}

export interface CreateConnectionInput {
  name: string;
  family: string;
  config?: Record<string, unknown>;
  /** Maps a config key to the name of a stored secret. */
  secretRefs?: Record<string, string>;
}

function assertNoInlineSecrets(config: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && /password|secret|token|api[-_]?key|private[-_]?key/i.test(key)) {
      throw ApiError.validation(
        `"${key}" must be stored as a secret and referenced by name, not embedded in the connection configuration`,
      );
    }
  }
}

export async function createConnection(context: ApiContext, input: CreateConnectionInput): Promise<PublicConnection> {
  authorize(context, "connection.create");
  if (!(FAMILIES as readonly string[]).includes(input.family)) {
    throw ApiError.validation(`Unknown connector family "${input.family}". Supported: ${FAMILIES.join(", ")}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/.test(input.name)) {
    throw ApiError.validation("Connection name must be 1-64 characters of letters, digits, space, dot, dash or underscore");
  }
  const config = input.config ?? {};
  assertNoInlineSecrets(config);

  // Every referenced secret must already exist, so a connection is never created
  // in a state that fails at 02:00.
  const available = new Set((await context.secrets.list(context.principal.organizationId)).map((s) => s.name));
  for (const [key, secret] of Object.entries(input.secretRefs ?? {})) {
    if (!available.has(secret)) {
      throw ApiError.validation(`Secret "${secret}" (referenced by "${key}") does not exist`);
    }
  }

  const now = context.now.toISOString();
  return audited(context, { action: "connection.create", resourceType: "connection", metadata: { family: input.family } }, async () =>
    context.store.createConnection({
      id: newId("conn"),
      organizationId: context.principal.organizationId,
      name: input.name,
      family: input.family,
      config: config as Connection["config"],
      secretRefs: input.secretRefs ?? {},
      createdBy: context.principal.userId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export async function updateConnection(
  context: ApiContext,
  connectionId: string,
  input: Partial<CreateConnectionInput>,
): Promise<PublicConnection> {
  authorize(context, "connection.edit");
  await getConnection(context, connectionId);
  if (input.config) assertNoInlineSecrets(input.config);

  return audited(context, { action: "connection.edit", resourceType: "connection", resourceId: connectionId }, async () =>
    context.store.updateConnection(context.principal.organizationId, connectionId, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.config ? { config: input.config as Connection["config"] } : {}),
      ...(input.secretRefs ? { secretRefs: input.secretRefs } : {}),
      updatedAt: context.now.toISOString(),
    }),
  );
}

export async function deleteConnection(context: ApiContext, connectionId: string): Promise<{ deleted: boolean }> {
  authorize(context, "connection.delete");
  const organizationId = context.principal.organizationId;
  await getConnection(context, connectionId);

  // Refuse while a published pipeline still points at it.
  const pipelines = await context.store.listPipelines(organizationId, { limit: 200 });
  for (const pipeline of pipelines.items) {
    if (!pipeline.publishedVersionId) continue;
    const version = await context.store.getVersion(organizationId, pipeline.publishedVersionId);
    const used = version?.definition.nodes.some((node) => node.config?.["connectionId"] === connectionId);
    if (used) {
      throw ApiError.conflict(`Pipeline "${pipeline.name}" uses this connection. Update it before deleting the connection.`);
    }
  }

  return audited(context, { action: "connection.delete", resourceType: "connection", resourceId: connectionId }, async () => ({
    deleted: await context.store.deleteConnection(organizationId, connectionId),
  }));
}

/**
 * Probes a connection. Credentials are resolved inside this process and the
 * result carries only a status and a message - never the credential or the
 * connection string.
 */
export async function testConnection(context: ApiContext, connectionId: string): Promise<ConnectionResult> {
  authorize(context, "connection.read");
  const organizationId = context.principal.organizationId;
  const connection = await getConnection(context, connectionId);

  const registry = new ConnectorRegistry({ organizationId });
  const config = {
    ...connection.config,
    ...Object.fromEntries(Object.entries(connection.secretRefs).map(([key, secret]) => [key, { secretRef: String(secret) }] as const)),
  };
  const resolved = await resolveSecrets(config, { organizationId, provider: context.secrets });

  const probed = await registry.testConnection(connection.family, resolved.value as never).finally(() => registry.close());

  // A driver's own error text is outside our control - `pg` and the HTTP client
  // both echo the target back, and a misconfigured host field can itself be a
  // full connection string. Redacting here is what makes the promise above true
  // for the stored message and the response alike.
  const result: ConnectionResult = { ...probed, message: redactString(probed.message) };
  await context.store.updateConnection(organizationId, connectionId, {
    lastTestedAt: context.now.toISOString(),
    lastTestOk: result.ok,
    lastTestMessage: result.message.slice(0, 500),
  });
  return result;
}
