import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  createStandaloneTicketService,
  generateTicketsService,
  getTicketService,
  listTicketsService,
  proposeTicketsForSalesOrderService,
} from "@/server/core/operations/ticket-service";
import {
  AFTER_SALES_SUBTYPES,
  TICKET_PRIORITIES,
  TICKET_TYPES,
} from "@/server/core/operations/ticket-rules";

/**
 * Module 04's opening act (specs/04-operations-projects.md §4): the ticket.
 *
 * Note what is **not** here: anything that generates tickets from an event. §4 rules it out —
 * "do not auto-generate silently" — so `propose` is a query somebody opens and `generate` is a
 * mutation somebody presses, and there is nothing in between.
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

const CONFIRMED_TICKET = z.object({
  type: z.enum(TICKET_TYPES),
  subType: z.enum(AFTER_SALES_SUBTYPES).nullish(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  title: z.string().min(1).max(200),
  scopeOfWork: z.string().min(1),
  specialInstructions: z.string().max(2000).nullish(),
  salesOrderLineIds: z.array(z.string()),
  requiredByDate: z.coerce.date().nullish(),
  assignedLeadId: z.string().nullish(),
});

export const operationsRouter = router({
  /**
   * §4's proposal. A query: it reads, computes and writes nothing, and opening it twice proposes
   * only what is still uncovered rather than a duplicate of what was generated the first time.
   */
  proposeTickets: p("ticket.generate")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ input }) => proposeTicketsForSalesOrderService(input.salesOrderId)),

  /** The confirmed set — what operations actually decided, which may be nothing like the proposal. */
  generateTickets: p("ticket.generate")
    .input(z.object({ salesOrderId: z.string(), tickets: z.array(CONFIRMED_TICKET) }))
    .mutation(({ ctx, input }) => generateTicketsService(actorMeta(ctx), input)),

  /** §4's warranty callback, emergency or goodwill visit — no order, and a required justification. */
  createStandaloneTicket: p("ticket.generate")
    .input(
      z.object({
        accountId: z.string(),
        siteId: z.string().nullish(),
        type: z.enum(TICKET_TYPES),
        subType: z.enum(AFTER_SALES_SUBTYPES).nullish(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        title: z.string().min(1).max(200),
        scopeOfWork: z.string().min(1),
        justification: z.string().min(3).max(1000),
        billable: z.boolean().optional(),
        requiredByDate: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createStandaloneTicketService(actorMeta(ctx), input)),

  listTickets: p("ticket.view")
    .input(
      z
        .object({
          status: z.string().optional(),
          type: z.string().optional(),
          salesOrderId: z.string().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listTicketsService(ctx.user, input ?? {})),

  getTicket: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ ctx, input }) => getTicketService(ctx.user, input.ticketId)),
});
