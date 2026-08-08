import { z } from "zod";
import { db } from "@/lib/db";
import {
  assignRoleService,
  createUserService,
  deleteUserService,
  removeRoleService,
  setUserActiveService,
  type ActorMeta,
} from "@/server/core/admin/service";
import { p, router, type Context } from "@/server/api/trpc";

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
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

  createUser: p("admin.manage_users")
    .input(z.object({ email: z.string().email(), name: z.string().min(1), roleKey: z.string() }))
    .mutation(({ ctx, input }) => createUserService(actorMeta(ctx), input)),

  assignRole: p("admin.manage_roles")
    .input(z.object({ userId: z.string(), roleKey: z.string() }))
    .mutation(({ ctx, input }) => assignRoleService(actorMeta(ctx), input)),

  removeRole: p("admin.manage_roles")
    .input(z.object({ userId: z.string(), roleKey: z.string() }))
    .mutation(({ ctx, input }) => removeRoleService(actorMeta(ctx), input)),

  setUserActive: p("admin.manage_users")
    .input(z.object({ userId: z.string(), isActive: z.boolean() }))
    .mutation(({ ctx, input }) => setUserActiveService(actorMeta(ctx), input)),

  deleteUser: p("admin.manage_users")
    .input(z.object({ userId: z.string() }))
    .mutation(({ ctx, input }) => deleteUserService(actorMeta(ctx), input)),
});
