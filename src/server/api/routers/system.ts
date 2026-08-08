import { visibleNavFor } from "@/server/core/nav";
import { protectedProcedure, router } from "@/server/api/trpc";

export const systemRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    roleKeys: ctx.user.roleKeys,
    permissions: [...ctx.user.permissions],
  })),

  /** The sidebar (specs/00-foundation.md §8). Logic lives in src/server/core/nav.ts so it stays
   *  testable outside the Next.js runtime; the registry is static, so there is no query behind
   *  this. */
  nav: protectedProcedure.query(({ ctx }) => visibleNavFor(ctx.user.permissions)),
});
