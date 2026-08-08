import { protectedProcedure, router } from "@/server/api/trpc";

export const systemRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    roleKeys: ctx.user.roleKeys,
    permissions: [...ctx.user.permissions],
  })),
});
