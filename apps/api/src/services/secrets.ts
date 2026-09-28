import type { SecretMetadata } from "@dataflow-studio/secrets";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";

/**
 * Secrets are write-only through the API.
 *
 * There is deliberately no endpoint that returns a secret value: the only code
 * that decrypts one is the worker, at the moment it needs it, and every such read
 * lands in the audit log. The UI shows a fingerprint so a user can tell whether a
 * value changed without ever seeing it.
 */
export async function listSecrets(context: ApiContext): Promise<SecretMetadata[]> {
  authorize(context, "secret.read");
  return context.secrets.list(context.principal.organizationId);
}

export async function createSecret(
  context: ApiContext,
  input: { name: string; value: string; description?: string },
): Promise<SecretMetadata> {
  authorize(context, "secret.create");
  if (!input.value) throw ApiError.validation("Secret value must not be empty");
  if (input.value.length > 64 * 1024) throw ApiError.validation("Secret value exceeds 64 KiB");

  return audited(
    context,
    { action: "secret.create", resourceType: "secret", resourceId: input.name, metadata: { description: input.description ?? null } },
    async () => context.secrets.write(context.principal.organizationId, input.name, input.value, input.description),
  );
}

export async function deleteSecret(context: ApiContext, name: string): Promise<{ deleted: boolean }> {
  authorize(context, "secret.delete");
  const organizationId = context.principal.organizationId;

  // Refuse while a connection still references it.
  for (const connection of await context.store.listConnections(organizationId)) {
    if (Object.values(connection.secretRefs).includes(name)) {
      throw ApiError.conflict(`Connection "${connection.name}" references this secret. Update it first.`);
    }
  }
  return audited(context, { action: "secret.delete", resourceType: "secret", resourceId: name }, async () => ({
    deleted: await context.secrets.delete(organizationId, name),
  }));
}
