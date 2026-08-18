import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getApprovalDecisionHandler } from "@/server/core/approvals/decision-registry";
import { listApprovalsForEntity, listMyApprovalInbox } from "@/server/core/approvals/service";
import "@/server/core/approvals/register-decision-handlers";
import { protectedProcedure, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

export const approvalsRouter = router({
  myInbox: protectedProcedure.query(({ ctx }) =>
    listMyApprovalInbox({
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      roleKeys: ctx.user.roleKeys,
      permissions: ctx.user.permissions,
    }),
  ),

  listForEntity: protectedProcedure
    .input(z.object({ entityType: z.string(), entityId: z.string() }))
    .query(({ input }) => listApprovalsForEntity(input.entityType, input.entityId)),

  /**
   * Decide from the global inbox — through the owning module, never around it.
   *
   * This used to call `decideApprovalRequest` directly, which updates the engine's row and nothing
   * else. The engine does not know that approving a cash advance releases it for payment or that
   * approving a quotation lets it be issued, so the request went to `approved` and the business
   * record stayed where it was, unreachable. That is what happened to AIESCA-260127 and it applied
   * to every approval type decided from this screen.
   *
   * An unregistered entity type is refused rather than half-decided. Loud and recoverable beats
   * quiet and stranded — see decision-registry.ts.
   */
  decide: protectedProcedure
    .input(
      z.object({
        requestId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const request = await db.approvalRequest.findUnique({
        where: { id: input.requestId },
        select: { entityType: true, entityId: true },
      });
      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That approval request no longer exists.",
        });
      }

      const handler = getApprovalDecisionHandler(request.entityType);
      if (!handler) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Approvals for ${request.entityType} cannot be decided from this screen yet — open the ` +
            `record itself and decide it there. (No module has said what approving a ` +
            `${request.entityType} should do, and deciding it here would record a decision that ` +
            `never reached the record.)`,
        });
      }

      return handler({
        requestId: input.requestId,
        entityId: request.entityId,
        decision: input.decision,
        comment: input.comment,
        actor: actorMeta(ctx),
        approver: {
          id: ctx.user.id,
          email: ctx.user.email,
          name: ctx.user.name,
          roleKeys: ctx.user.roleKeys,
          permissions: ctx.user.permissions,
        },
      });
    }),
});
