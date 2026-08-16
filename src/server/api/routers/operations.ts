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
import {
  CASH_ADVANCE_CATEGORIES,
  RELEASE_METHODS,
} from "@/server/core/operations/cash-advance-rules";
import { listInspectionAssigneesService } from "@/server/core/crm/inspection-service";
import {
  approveMethodologyService,
  createMethodologyService,
  getMethodologyService,
  listMethodologiesService,
  listReusableMethodologiesService,
  methodologyGateForTicket,
  overrideMethodologyGateService,
  recordClientDecisionService,
  saveMethodologyService,
  submitForInternalReviewService,
  submitToClientService,
  waiveClientApprovalService,
} from "@/server/core/operations/methodology-service";
import {
  approveInspectionService,
  completeInspectionService,
  getInspectionService,
  listInspectionsService,
  saveInspectionService,
  scheduleInspectionService,
} from "@/server/core/operations/site-inspection-service";
import {
  cashAdvanceGateForTicket,
  decideCashAdvanceService,
  decideExtensionService,
  getCashAdvanceService,
  liquidateCashAdvanceService,
  listLiquidationsAwaitingCheckService,
  reviewLiquidationService,
  listCashAdvancesService,
  overrideCashAdvanceGateService,
  releaseCashAdvanceService,
  requestCashAdvanceService,
  requestEligibilityService,
  requestExtensionService,
  submitCashAdvanceService,
} from "@/server/core/operations/cash-advance-service";

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

  // ---- §5's cash advance ------------------------------------------------------------------------

  /**
   * §1's Gate 1 for one ticket, as a query.
   *
   * A query rather than a field on `getTicket` because §8's mobilization will ask the same question
   * of the same function, and because the ticket screen re-reads it after a release without
   * refetching the whole record.
   */
  cashAdvanceGate: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => cashAdvanceGateForTicket(input.ticketId)),

  /**
   * Whether the caller may ask for another advance (§5's block on overdue liquidation).
   *
   * Gated on `cash_advance.request` and scoped to the caller's own id — deliberately not accepting a
   * `userId`. "Is this person blocked?" about somebody else is a question about their paperwork,
   * and the register answers it for the people entitled to ask.
   */
  cashAdvanceEligibility: p("cash_advance.request").query(({ ctx }) =>
    requestEligibilityService(ctx.user.id),
  ),

  requestCashAdvance: p("cash_advance.request")
    .input(
      z.object({
        ticketId: z.string().nullish(),
        projectId: z.string().nullish(),
        requestedFor: z.array(z.string()).default([]),
        purpose: z.string().min(3).max(500),
        breakdown: z
          .array(
            z.object({
              category: z.enum(CASH_ADVANCE_CATEGORIES),
              description: z.string().max(300).default(""),
              // Centavos. Integers cross the wire, so nothing is parsed out of a float.
              amount: z.number().int().nonnegative(),
            }),
          )
          .min(1),
        neededBy: z.coerce.date(),
        submit: z.boolean().default(true),
      }),
    )
    .mutation(({ ctx, input }) => requestCashAdvanceService(actorMeta(ctx), input)),

  submitCashAdvance: p("cash_advance.request")
    .input(z.object({ cashAdvanceId: z.string() }))
    .mutation(({ ctx, input }) => submitCashAdvanceService(actorMeta(ctx), input.cashAdvanceId)),

  /** §5: the Vice President, with the President taking over after 4 working hours. */
  decideCashAdvance: p("cash_advance.approve")
    .input(
      z.object({
        cashAdvanceId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => decideCashAdvanceService(actorMeta(ctx), ctx.user, input)),

  releaseCashAdvance: p("cash_advance.release")
    .input(
      z.object({
        cashAdvanceId: z.string(),
        method: z.enum(RELEASE_METHODS),
        amountCentavos: z.number().int().positive().optional(),
        expectedDemobilisation: z.coerce.date().optional(),
      }),
    )
    .mutation(({ ctx, input }) => releaseCashAdvanceService(actorMeta(ctx), input)),

  /**
   * Filing receipts.
   *
   * Gated on `cash_advance.request` rather than a permission of its own: the person who took the
   * money is the person who accounts for it, and the service checks they are on the advance.
   */
  liquidateCashAdvance: p("cash_advance.request")
    .input(
      z.object({
        cashAdvanceId: z.string(),
        lines: z
          .array(
            z.object({
              date: z.string(),
              category: z.enum(CASH_ADVANCE_CATEGORIES),
              description: z.string().max(300).default(""),
              amount: z.number().int().nonnegative(),
              receiptFileId: z.string().nullish(),
              hasOfficialReceipt: z.boolean().default(false),
            }),
          )
          .min(1),
        amountReturnedCentavos: z.number().int().nonnegative().optional(),
        remarks: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => liquidateCashAdvanceService(actorMeta(ctx), input)),

  /** §5's review: somebody with the paper in hand settles it, or sends it back. */
  reviewLiquidation: p("cash_advance.review_liquidation")
    .input(
      z.object({
        liquidationId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        remarks: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => reviewLiquidationService(actorMeta(ctx), input)),

  liquidationsAwaitingCheck: p("cash_advance.review_liquidation").query(() =>
    listLiquidationsAwaitingCheckService(),
  ),

  requestLiquidationExtension: p("cash_advance.request")
    .input(
      z.object({
        cashAdvanceId: z.string(),
        reason: z.string().min(10).max(1000),
        newDueAt: z.coerce.date(),
      }),
    )
    .mutation(({ ctx, input }) => requestExtensionService(actorMeta(ctx), input)),

  decideLiquidationExtension: p("cash_advance.approve_extension")
    .input(
      z.object({
        cashAdvanceId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => decideExtensionService(actorMeta(ctx), ctx.user, input)),

  /**
   * The register (§5).
   *
   * `ticket.view` rather than `cash_advance.view_register`: a technician opening their own ticket
   * needs to see their own advance, and the service scopes non-register-holders to advances they
   * are on. The nav entry is what `cash_advance.view_register` gates.
   */
  listCashAdvances: p("ticket.view")
    .input(
      z
        .object({
          scope: z.enum(["outstanding", "late", "mine", "all"]).optional(),
          ticketId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listCashAdvancesService(ctx.user, input ?? {})),

  getCashAdvance: p("ticket.view")
    .input(z.object({ cashAdvanceId: z.string() }))
    .query(({ ctx, input }) => getCashAdvanceService(ctx.user, input.cashAdvanceId)),

  /** §19's `operations.override_ca_gate`, with the reason that makes it worth having. */
  overrideCashAdvanceGate: p("operations.override_ca_gate")
    .input(z.object({ ticketId: z.string(), reason: z.string().min(10).max(1000) }))
    .mutation(({ ctx, input }) => overrideCashAdvanceGateService(actorMeta(ctx), input)),

  // ---- §6.1's site inspection -------------------------------------------------------------------

  /**
   * Who could have attended a site visit.
   *
   * Reuses module 01's list rather than growing a second one — "people who might go to a site" is
   * one question, and two answers would drift. Gated on `ticket.execute` rather than module 01's
   * `inspection.request`, because the person filling in the report is the technician who went, and
   * they do not necessarily hold the permission that *asks* for a visit.
   */
  inspectionAttendees: p("ticket.execute").query(() => listInspectionAssigneesService()),

  scheduleInspection: p("ticket.execute")
    .input(
      z.object({
        ticketId: z.string().nullish(),
        projectId: z.string().nullish(),
        inquiryId: z.string().nullish(),
        siteId: z.string().nullish(),
        scheduledFor: z.coerce.date().nullish(),
        inspectedByIds: z.array(z.string()).default([]),
      }),
    )
    .mutation(({ ctx, input }) => scheduleInspectionService(actorMeta(ctx), input)),

  /**
   * Records what the surveyor found — and, when the scope grew, tells sales on the spot.
   *
   * `scopeChangeIdentified` is on the *save*, not on completion, deliberately: §6.1's value is how
   * early the warning lands, and a surveyor who flags it from site on Tuesday should not have it
   * held until the paperwork is finished on Friday.
   */
  saveInspection: p("ticket.execute")
    .input(
      z.object({
        inspectionId: z.string(),
        inspectedAt: z.coerce.date().nullish(),
        inspectedByIds: z.array(z.string()).optional(),
        findings: z.string().max(20000).nullish(),
        existingConditions: z.record(z.string(), z.unknown()).optional(),
        measurements: z
          .array(
            z.object({
              label: z.string().max(200),
              value: z.string().max(100),
              unit: z.string().max(30).default(""),
            }),
          )
          .optional(),
        tagNumbers: z.array(z.string().max(100)).optional(),
        accessConstraints: z.string().max(5000).nullish(),
        permitsRequired: z.array(z.string().max(200)).optional(),
        hazards: z.array(z.string().max(200)).optional(),
        utilitiesAvailable: z
          .record(
            z.string(),
            z.object({ available: z.boolean(), note: z.string().max(300).optional() }),
          )
          .optional(),
        photoFileIds: z.array(z.string()).optional(),
        sketchFileIds: z.array(z.string()).optional(),
        scopeChangeIdentified: z.boolean().optional(),
        scopeChangeNotes: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => saveInspectionService(actorMeta(ctx), input)),

  completeInspection: p("ticket.execute")
    .input(z.object({ inspectionId: z.string() }))
    .mutation(({ ctx, input }) => completeInspectionService(actorMeta(ctx), input.inspectionId)),

  /** §6.1's `approved`. See INSPECTION_APPROVE_PERMISSION for why `project.manage` gates it. */
  approveInspection: p("project.manage")
    .input(z.object({ inspectionId: z.string() }))
    .mutation(({ ctx, input }) => approveInspectionService(actorMeta(ctx), input.inspectionId)),

  listInspections: p("ticket.view")
    .input(
      z
        .object({
          status: z.string().optional(),
          ticketId: z.string().optional(),
          inquiryId: z.string().optional(),
          scopeChangeOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listInspectionsService(ctx.user, input ?? {})),

  getInspection: p("ticket.view")
    .input(z.object({ inspectionId: z.string() }))
    .query(({ ctx, input }) => getInspectionService(ctx.user, input.inspectionId)),

  // ---- §6.2's method statement ------------------------------------------------------------------

  createMethodology: p("methodology.prepare")
    .input(
      z.object({
        projectId: z.string().nullish(),
        ticketId: z.string().nullish(),
        title: z.string().min(1).max(200),
        cloneFromId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createMethodologyService(actorMeta(ctx), input)),

  saveMethodology: p("methodology.prepare")
    .input(
      z.object({
        methodologyId: z.string(),
        title: z.string().min(1).max(200).optional(),
        scopeSummary: z.string().max(20000).optional(),
        sequenceOfWork: z
          .array(
            z.object({
              step: z.number().int(),
              description: z.string().max(1000),
              durationHours: z.number().nonnegative(),
              crew: z.string().max(200).default(""),
            }),
          )
          .optional(),
        manpowerPlan: z
          .array(
            z.object({
              role: z.string().max(120),
              count: z.number().int().nonnegative(),
              notes: z.string().max(300).optional(),
            }),
          )
          .optional(),
        toolsRequired: z.array(z.string().max(200)).optional(),
        materialsRequired: z
          .array(
            z.object({
              description: z.string().max(300),
              quantity: z.string().max(40),
              unit: z.string().max(30),
            }),
          )
          .optional(),
        safetyPlan: z.string().max(20000).nullish(),
        jsaFileId: z.string().nullish(),
        permitsRequired: z.array(z.string().max(200)).optional(),
        environmentalConsiderations: z.string().max(5000).nullish(),
        durationDays: z.number().int().positive().nullish(),
        mobilizationPlan: z.string().max(5000).nullish(),
        demobilizationPlan: z.string().max(5000).nullish(),
        contingencyPlan: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => saveMethodologyService(actorMeta(ctx), input)),

  submitMethodologyForReview: p("methodology.prepare")
    .input(z.object({ methodologyId: z.string() }))
    .mutation(({ ctx, input }) =>
      submitForInternalReviewService(actorMeta(ctx), input.methodologyId),
    ),

  /** §6.2's internal sign-off, before the client ever sees it. */
  approveMethodology: p("methodology.approve")
    .input(
      z.object({
        methodologyId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => approveMethodologyService(actorMeta(ctx), input)),

  /** Starts §6.2's clock. The date is written by the act of sending, never typed in later. */
  submitMethodologyToClient: p("methodology.prepare")
    .input(z.object({ methodologyId: z.string() }))
    .mutation(({ ctx, input }) => submitToClientService(actorMeta(ctx), input.methodologyId)),

  recordClientDecision: p("methodology.prepare")
    .input(
      z.object({
        methodologyId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        approvalFileId: z.string().nullish(),
        notes: z.string().max(5000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordClientDecisionService(actorMeta(ctx), input)),

  /** §6.2's rare exception, with a mandatory reason — not a checkbox. */
  waiveClientApproval: p("methodology.approve")
    .input(z.object({ methodologyId: z.string(), reason: z.string().min(10).max(1000) }))
    .mutation(({ ctx, input }) => waiveClientApprovalService(actorMeta(ctx), input)),

  methodologyGate: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => methodologyGateForTicket(input.ticketId)),

  overrideMethodologyGate: p("operations.override_methodology_gate")
    .input(z.object({ ticketId: z.string(), reason: z.string().min(10).max(1000) }))
    .mutation(({ ctx, input }) => overrideMethodologyGateService(actorMeta(ctx), input)),

  listMethodologies: p("ticket.view")
    .input(
      z
        .object({
          projectId: z.string().optional(),
          ticketId: z.string().optional(),
          status: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => listMethodologiesService(input ?? {})),

  /** §6.2's institutional library — only ones a client actually approved. */
  reusableMethodologies: p("methodology.prepare").query(() => listReusableMethodologiesService()),

  getMethodology: p("ticket.view")
    .input(z.object({ methodologyId: z.string() }))
    .query(({ ctx, input }) => getMethodologyService(ctx.user, input.methodologyId)),
});
