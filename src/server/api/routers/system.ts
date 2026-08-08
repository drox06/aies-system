import { registry } from "@/server/core/manifests";
import { protectedProcedure, router } from "@/server/api/trpc";

export const systemRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    roleKeys: ctx.user.roleKeys,
    permissions: [...ctx.user.permissions],
  })),

  /**
   * The sidebar, assembled from module manifests and filtered to what this user may actually
   * reach (specs/00-foundation.md §8).
   *
   * Filtering happens here rather than in the client so an unreachable route is never named in a
   * response — a nav label like "Cost analysis" is itself a disclosure, even if clicking it 403s.
   * The registry is static, so this is a pure in-memory read with no query behind it.
   */
  nav: protectedProcedure.query(({ ctx }) =>
    registry.nav
      .filter((entry) => !entry.permission || ctx.user.permissions.has(entry.permission))
      .map((entry) => ({
        label: entry.label,
        href: entry.href,
        icon: entry.icon ?? null,
        group: entry.group ?? null,
      })),
  ),
});
