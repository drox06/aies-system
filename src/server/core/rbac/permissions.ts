import { db } from "@/lib/db";

export interface KeyedGrant {
  key: string;
}

export interface OverrideGrant {
  key: string;
  granted: boolean;
}

/**
 * Pure computation: union of every role's permission keys, then apply per-user overrides
 * (specs/00-foundation.md §4.2 — "union of role permissions, then apply per-user overrides").
 * Kept separate from the Prisma fetch below so it's unit-testable without a database.
 */
export function computePermissionSet(
  roleGrants: readonly (readonly KeyedGrant[])[],
  overrides: readonly OverrideGrant[],
): Set<string> {
  const permissions = new Set<string>();
  for (const grants of roleGrants) {
    for (const grant of grants) {
      permissions.add(grant.key);
    }
  }
  for (const override of overrides) {
    if (override.granted) {
      permissions.add(override.key);
    } else {
      permissions.delete(override.key);
    }
  }
  return permissions;
}

export async function resolveUserPermissions(userId: string): Promise<Set<string>> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      roles: {
        select: {
          role: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
        },
      },
      permissionOverrides: {
        select: { granted: true, permission: { select: { key: true } } },
      },
    },
  });

  const roleGrants = user.roles.map((userRole) =>
    userRole.role.permissions.map((rolePermission) => rolePermission.permission),
  );
  const overrides = user.permissionOverrides.map((override) => ({
    key: override.permission.key,
    granted: override.granted,
  }));

  return computePermissionSet(roleGrants, overrides);
}

export async function resolveUserRoleKeys(userId: string): Promise<string[]> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { roles: { select: { role: { select: { key: true } } } } },
  });
  return user.roles.map((userRole) => userRole.role.key);
}
