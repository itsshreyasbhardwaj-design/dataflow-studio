import type { ApiKeyRecord, Role } from "@dataflow-studio/database";
import { ApiError } from "../errors.js";
import { audited, authorize, type ApiContext } from "../context.js";
import { generateApiKey, newApiKeyRecordId } from "../auth.js";
import { hasPermission, permissionsFor, type Permission } from "../rbac.js";

export type PublicApiKey = Omit<ApiKeyRecord, "tokenHash">;

function strip(record: ApiKeyRecord): PublicApiKey {
  const { tokenHash: _hash, ...rest } = record;
  return rest;
}

export async function listApiKeys(context: ApiContext): Promise<PublicApiKey[]> {
  authorize(context, "apikey.read");
  return (await context.store.listApiKeys(context.principal.organizationId)).map(strip);
}

export interface CreateApiKeyResult {
  key: PublicApiKey;
  /** Shown once. Only the hash is stored. */
  token: string;
  permissions: Permission[];
}

export async function createApiKey(
  context: ApiContext,
  input: { name: string; role: Role; expiresInDays?: number; environment?: "live" | "test" },
): Promise<CreateApiKeyResult> {
  authorize(context, "apikey.create");
  if (!input.name.trim()) throw ApiError.validation("API key name is required");

  // A key must not out-rank the person creating it.
  const escalates = permissionsFor(input.role).some((permission) => !hasPermission(context.principal.role, permission));
  if (escalates) {
    throw ApiError.forbidden(`You cannot create a key with the "${input.role}" role, which exceeds your own permissions`);
  }

  const { token, tokenHash, prefix } = generateApiKey(input.environment ?? "live");
  const record: ApiKeyRecord = {
    id: newApiKeyRecordId(),
    organizationId: context.principal.organizationId,
    name: input.name.trim().slice(0, 100),
    tokenHash,
    prefix,
    role: input.role,
    createdBy: context.principal.userId,
    createdAt: context.now.toISOString(),
    ...(input.expiresInDays
      ? { expiresAt: new Date(context.now.getTime() + input.expiresInDays * 86_400_000).toISOString() }
      : {}),
  };

  return audited(
    context,
    { action: "apikey.create", resourceType: "api_key", resourceId: record.id, metadata: { role: input.role, name: record.name } },
    async () => ({
      key: strip(await context.store.createApiKey(record)),
      token,
      permissions: permissionsFor(input.role),
    }),
  );
}

export async function revokeApiKey(context: ApiContext, keyId: string): Promise<{ revoked: boolean }> {
  authorize(context, "apikey.create");
  return audited(context, { action: "apikey.revoke", resourceType: "api_key", resourceId: keyId }, async () => {
    const revoked = await context.store.revokeApiKey(context.principal.organizationId, keyId, context.now.toISOString());
    if (!revoked) throw ApiError.notFound("API key", keyId);
    return { revoked };
  });
}
