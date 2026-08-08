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
