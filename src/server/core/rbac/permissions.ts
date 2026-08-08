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

export interface SessionUser {
  isActive: boolean;
  deletedAt: Date | null;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  roleKeys: string[];
  permissions: Set<string>;
}

/**
 * Everything the Auth.js session callback needs, in ONE round-trip.
 *
 * That callback runs on every single request (docs/DECISIONS.md #4, which is what makes a
 * revoked permission take effect immediately). It used to call `user.findUnique`,
 * `resolveUserRoleKeys` and `resolveUserPermissions` separately — three queries against the same
 * user row, each a full network round-trip. Measured against Supabase Singapore from Manila that
 * was ~183ms each, so ~550ms of latency was being added to every page load and every tRPC batch
 * before any of the page's own work started. Collapsing them makes it ~183ms, and cuts the
 * database's per-request load by two thirds in production too.
 *
 * Returns null when the user no longer exists, so the caller can distinguish "deleted" from
 * "could not ask" (docs/DECISIONS.md #16).
 */
export async function resolveSessionUser(userId: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      deletedAt: true,
      totpEnabled: true,
      mustChangePassword: true,
      roles: {
        select: {
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
      permissionOverrides: { select: { granted: true, permission: { select: { key: true } } } },
    },
  });
  if (!user) return null;

  return {
    isActive: user.isActive,
    deletedAt: user.deletedAt,
    totpEnabled: user.totpEnabled,
    mustChangePassword: user.mustChangePassword,
    roleKeys: user.roles.map((userRole) => userRole.role.key),
    permissions: computePermissionSet(
      user.roles.map((userRole) =>
        userRole.role.permissions.map((rolePermission) => rolePermission.permission),
      ),
      user.permissionOverrides.map((override) => ({
        key: override.permission.key,
        granted: override.granted,
      })),
    ),
  };
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
