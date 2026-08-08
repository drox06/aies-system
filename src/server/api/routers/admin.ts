import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { p, router } from "@/server/api/trpc";

function randomTempPassword(): string {
  return `Temp-${randomUUID().slice(0, 8)}-${randomUUID().slice(0, 8)}`;
}

export const adminRouter = router({
  listUsers: p("admin.manage_users").query(async () => {
    const users = await db.user.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        isDemoUser: true,
        totpEnabled: true,
        mustChangePassword: true,
        roles: { select: { role: { select: { key: true, name: true } } } },
      },
    });

    return users.map((user) => ({
      ...user,
      roles: user.roles.map((userRole) => userRole.role),
    }));
  }),

  listRoles: p("admin.manage_roles").query(() =>
    db.role.findMany({ orderBy: { name: "asc" }, select: { id: true, key: true, name: true } }),
  ),

  // Assigns a temporary, high-entropy password and forces a change at first login
  // (mustChangePassword) — the plaintext is returned once so the admin can hand it to the new
  // user out of band; nothing persists it beyond the argon2id hash.
  createUser: p("admin.manage_users")
    .input(z.object({ email: z.string().email(), name: z.string().min(1), roleKey: z.string() }))
    .mutation(async ({ input }) => {
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

      const user = await db.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          mustChangePassword: true,
          roles: { create: { roleId: role.id } },
        },
      });

      return { id: user.id, email: user.email, tempPassword };
    }),

  assignRole: p("admin.manage_roles")
    .input(z.object({ userId: z.string(), roleKey: z.string() }))
    .mutation(async ({ input }) => {
      const role = await db.role.findUnique({ where: { key: input.roleKey } });
      if (!role) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role." });
      }

      await db.userRole.upsert({
        where: { userId_roleId: { userId: input.userId, roleId: role.id } },
        update: {},
        create: { userId: input.userId, roleId: role.id },
      });

      return { ok: true as const };
    }),

  removeRole: p("admin.manage_roles")
    .input(z.object({ userId: z.string(), roleKey: z.string() }))
    .mutation(async ({ input }) => {
      const role = await db.role.findUnique({ where: { key: input.roleKey } });
      if (!role) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role." });
      }

      await db.userRole.deleteMany({ where: { userId: input.userId, roleId: role.id } });

      return { ok: true as const };
    }),
});
