import { homeSummaryService } from "@/server/core/home/home-service";
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
  /**
   * What needs this person, across every module — the content of `/`.
   *
   * There is deliberately no nav entry for it. The company's decision of 2026-08-17: keep the page,
   * do not put it in everybody's sidebar, and grow it into DJ's dashboard when module 09 lands —
   * spec 09 §2 calls DJ's blocked-at-a-gate widget "the single most useful widget in the platform
   * for this company", and this page already carries it.
   */
  home: protectedProcedure.query(({ ctx }) => homeSummaryService(ctx.user)),

  nav: protectedProcedure.query(({ ctx }) => visibleNavFor(ctx.user.permissions)),
});
