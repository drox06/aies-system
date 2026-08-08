import { hash } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";

// Separated from src/server/api/routers/admin.ts (Spec.md §3.5's router.ts/service.ts split) so
// this logic — and its audit-transaction guarantee — can be unit/integration tested without
// pulling in the tRPC + Auth.js stack, which only works inside the Next.js runtime.

export interface ActorMeta {
  actorId: string;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

function randomTempPassword(): string {
  return `Temp-${randomUUID().slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

export async function createUserService(
  actor: ActorMeta,
  input: { email: string; name: string; roleKey: string },
) {
  const role = await db.role.findUnique({ where: { key: input.roleKey } });
  if (!role) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role." });
  }

  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "Email already in use." });
  }

  const tempPassword = randomTempPassword();
  const passwordHash = await hash(tempPassword);

  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        mustChangePassword: true,
        roles: { create: { roleId: role.id } },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: "User",
      entityId: user.id,
      summary: `Created user ${user.email} with role ${role.name}`,
      diff: {
        email: { from: null, to: user.email },
        name: { from: null, to: user.name },
        roleKey: { from: null, to: role.key },
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: user.id, email: user.email, tempPassword };
  });
}

export async function assignRoleService(
  actor: ActorMeta,
  input: { userId: string; roleKey: string },
) {
  const role = await db.role.findUnique({ where: { key: input.roleKey } });
  if (!role) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role." });
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true, roles: { select: { role: { select: { key: true } } } } },
    });
    const rolesBefore = user.roles.map((userRole) => userRole.role.key);

    await tx.userRole.upsert({
      where: { userId_roleId: { userId: input.userId, roleId: role.id } },
      update: {},
      create: { userId: input.userId, roleId: role.id },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "role_assigned",
      entityType: "User",
      entityId: input.userId,
      summary: `Assigned role ${role.name} to ${user.email}`,
      diff: { roles: { from: rolesBefore, to: [...new Set([...rolesBefore, role.key])] } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}

export async function removeRoleService(
  actor: ActorMeta,
  input: { userId: string; roleKey: string },
) {
  const role = await db.role.findUnique({ where: { key: input.roleKey } });
  if (!role) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role." });
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true, roles: { select: { role: { select: { key: true } } } } },
    });
    const rolesBefore = user.roles.map((userRole) => userRole.role.key);

    await tx.userRole.deleteMany({ where: { userId: input.userId, roleId: role.id } });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "role_removed",
      entityType: "User",
      entityId: input.userId,
      summary: `Removed role ${role.name} from ${user.email}`,
      diff: { roles: { from: rolesBefore, to: rolesBefore.filter((key) => key !== role.key) } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}

/**
 * Deactivate or reactivate a user. Spec.md §10's cross-cutting rule is soft-delete everywhere,
 * and this is the reversible half of it: `isActive: false` is the correct answer for someone who
 * has left, because their audit history, approvals and comments must all stay attributable.
 *
 * Takes effect on the deactivated user's very next request, without waiting for a token to
 * expire, because the session callback re-reads `isActive` every time (docs/DECISIONS.md #4).
 */
export async function setUserActiveService(
  actor: ActorMeta,
  input: { userId: string; isActive: boolean },
) {
  // Locking yourself out of the only account that can manage users is unrecoverable through the
  // UI — it would need someone with database access. Cheaper to refuse.
  if (input.userId === actor.actorId && !input.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "You cannot deactivate your own account.",
    });
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true, isActive: true },
    });

    if (user.isActive === input.isActive) {
      return { ok: true as const };
    }

    await tx.user.update({
      where: { id: input.userId },
      data: { isActive: input.isActive },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.isActive ? "reactivated" : "deactivated",
      entityType: "User",
      entityId: input.userId,
      summary: `${input.isActive ? "Reactivated" : "Deactivated"} ${user.email}`,
      diff: { isActive: { from: user.isActive, to: input.isActive } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}

/**
 * Soft-delete a user (Spec.md §10: "Soft-delete with deletedAt + deletedBy").
 *
 * Never a hard delete. Every AuditLog row, approval decision and comment references this id, and
 * an ISO 9001 evidence trail that cannot name who approved something is not an evidence trail.
 * The row stays; `listUsers` filters on `deletedAt: null`, and the session callback treats a
 * deleted user as unauthenticated, so they lose access immediately.
 *
 * The email is released for reuse by suffixing the stored one, since it is uniquely indexed and a
 * departed employee's address is sometimes reissued.
 */
export async function deleteUserService(actor: ActorMeta, input: { userId: string }) {
  if (input.userId === actor.actorId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account." });
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true, deletedAt: true },
    });

    if (user.deletedAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That user is already deleted." });
    }

    const deletedAt = new Date();
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deletedAt,
        deletedBy: actor.actorId,
        isActive: false,
        // Free the unique email for reuse while keeping the original readable in the audit trail.
        email: `${user.email}#deleted-${deletedAt.getTime()}`,
        // A deleted account must not remain signable-in even if the row is later restored by
        // hand, so its credentials go with it.
        totpSecret: null,
        totpEnabled: false,
      },
    });

    // Role grants are removed rather than soft-deleted: they confer access, and leaving them
    // attached to a deleted user is a trap for any future query that forgets the deletedAt filter.
    await tx.userRole.deleteMany({ where: { userId: input.userId } });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: "User",
      entityId: input.userId,
      summary: `Deleted ${user.email}`,
      diff: { deletedAt: { from: null, to: deletedAt.toISOString() } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}
