import { z } from "zod";
import {
  decideApprovalRequest,
  listApprovalsForEntity,
  listMyApprovalInbox,
} from "@/server/core/approvals/service";
import { protectedProcedure, router } from "@/server/api/trpc";

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

  decide: protectedProcedure
    .input(
      z.object({
        requestId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      decideApprovalRequest({
        requestId: input.requestId,
        decision: input.decision,
        comment: input.comment,
        approver: {
          id: ctx.user.id,
          email: ctx.user.email,
          name: ctx.user.name,
          roleKeys: ctx.user.roleKeys,
          permissions: ctx.user.permissions,
        },
      }),
    ),
});
