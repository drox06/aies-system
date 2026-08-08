import { z } from "zod";
import { db } from "@/lib/db";
import { p, router } from "@/server/api/trpc";

// specs/00-foundation.md §5: "A reusable <AuditTrail entityType entityId /> component renders
// the history on every record." Gated on admin.manage_users for now since User is the only
// entity type with an audit trail so far — generalize to a per-entityType permission registry
// (mirroring src/server/core/rbac/scope.ts's pattern) once a second entity type needs one.
export const auditRouter = router({
  listForEntity: p("admin.manage_users")
    .input(z.object({ entityType: z.string(), entityId: z.string() }))
    .query(({ input }) =>
      db.auditLog.findMany({
        where: { entityType: input.entityType, entityId: input.entityId },
        orderBy: { at: "desc" },
        take: 50,
      }),
    ),
});
