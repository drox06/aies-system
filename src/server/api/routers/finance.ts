import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  billableMilestonesService,
  cancelMilestoneService,
  generateScheduleService,
  getScheduleService,
} from "@/server/core/finance/billing-service";

/**
 * Module 05's procedures. Session 1 covers §2's billing schedule only.
 *
 * §10 is unambiguous about the defaults — "Money is the most sensitive data in the system. Default
 * every finance permission to off" — so every procedure here is gated, and the read is gated too.
 * A billing schedule shows what the company will invoice and when, which is commercial information
 * about a customer relationship and not something the whole company needs.
 */

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

export const financeRouter = router({
  /** §2's work list: everything an event has made billable, oldest due first. */
  billable: p("billing_statement.create")
    .input(z.object({ accountId: z.string().optional() }).optional())
    .query(({ input }) => billableMilestonesService(input ?? {})),

  /** One order's plan. Null when nobody has planned it yet, which the screen says out loud. */
  schedule: p("finance.view")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ input }) => getScheduleService(input.salesOrderId)),

  generateSchedule: p("billing_schedule.manage")
    .input(z.object({ salesOrderId: z.string(), paymentTermId: z.string().optional() }))
    .mutation(({ ctx, input }) => generateScheduleService(actorMeta(ctx), input)),

  cancelMilestone: p("billing_schedule.manage")
    .input(z.object({ milestoneId: z.string(), reason: z.string().min(5).max(1000) }))
    .mutation(({ ctx, input }) => cancelMilestoneService(actorMeta(ctx), input)),
});
