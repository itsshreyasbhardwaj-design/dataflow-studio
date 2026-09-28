import type { Role } from "@dataflow-studio/database";
import { ApiError } from "./errors.js";

export const PERMISSIONS = [
  "pipeline.read",
  "pipeline.create",
  "pipeline.edit",
  "pipeline.execute",
  "pipeline.cancel",
  "pipeline.delete",
  "workflow.publish",
  "workflow.schedule",
  "backfill.create",
  "connection.read",
  "connection.create",
  "connection.edit",
  "connection.delete",
  "secret.read",
  "secret.create",
  "secret.delete",
  "dataset.read",
  "incident.read",
  "incident.edit",
  "quality.override",
  "analytics.read",
  "audit.read",
  "apikey.read",
  "apikey.create",
  "member.manage",
  "organization.edit",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  "pipeline.read", "connection.read", "dataset.read", "incident.read", "analytics.read",
];

const DEVELOPER: Permission[] = [
  ...VIEWER,
  "pipeline.create", "pipeline.edit", "pipeline.execute", "pipeline.cancel",
  "workflow.publish", "workflow.schedule", "backfill.create",
  "connection.create", "connection.edit",
  // Developers may add a credential but never read one back, and may not delete
  // one another service might still depend on.
  "secret.create", "secret.read",
  "incident.edit",
];

const ADMIN: Permission[] = [
  ...DEVELOPER,
  "pipeline.delete", "connection.delete", "secret.delete",
  "quality.override", "audit.read", "apikey.read", "apikey.create", "member.manage",
];

const OWNER: Permission[] = [...ADMIN, "organization.edit"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  developer: DEVELOPER,
  admin: ADMIN,
  owner: OWNER,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Throws unless the role grants the permission. Called at the top of every
 * mutating service function, not in the route handler, so an endpoint added later
 * cannot forget it.
 */
export function requirePermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw ApiError.forbidden(
      `Your role (${role}) does not include "${permission}". Ask an administrator for a role with that permission.`,
    );
  }
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
