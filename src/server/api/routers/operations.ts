import { z } from "zod";
import { p, protectedProcedure, router, type Context } from "@/server/api/trpc";
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
import { ITEM_TYPES, SOURCES } from "@/server/core/operations/material-request-rules";
import { CLEARANCE_STATES, MOBILIZATION_TYPES } from "@/server/core/operations/mobilization-rules";
import { STANDBY_CAUSES } from "@/server/core/operations/daily-progress-rules";
import { DEFECT_SEVERITIES, EVIDENCE_TYPES } from "@/server/core/operations/qa-rules";
import {
  firstTimeRightService,
  listQaForTicketService,
  recordQaService,
} from "@/server/core/operations/qa-service";
import { ATTEMPT_FAILURE_CAUSES, DELIVERY_MODES } from "@/server/core/operations/delivery-rules";
// Aliased: `material-request-rules` exports its own `ITEM_TYPES`, and the two are unrelated —
// one is what a store issues, the other is what a checklist asks.
import { ITEM_TYPES as CHECKLIST_ITEM_TYPES } from "@/server/core/operations/checklist-rules";
import {
  activeTemplateService,
  completeResponseService,
  createTemplateService,
  deleteResponseService,
  getResponseService,
  listResponsesForTicketService,
  listTemplatesService,
  publishTemplateService,
  reviseTemplateService,
  saveAnswersService,
  saveDraftService,
  startResponseService,
} from "@/server/core/operations/checklist-service";
import { EXPENSE_CATEGORIES } from "@/server/core/operations/timesheet-rules";
import {
  advanceLiquidationService,
  decideExpenseService,
  decideTimesheetService,
  expensesAwaitingService,
  listExpensesService,
  myTimesheetsService,
  saveExpenseService,
  saveTimesheetService,
  submitExpensesService,
  submitTimesheetsService,
  ticketHoursService,
  timesheetsAwaitingService,
} from "@/server/core/operations/timesheet-service";
import { UNAVAILABILITY_KINDS } from "@/server/core/operations/dispatch-rules";
import {
  bumpForEmergencyService,
  capacityService,
  dispatchBoardService,
  previewScheduleService,
  listUnavailabilityService,
  recordUnavailabilityService,
  removeUnavailabilityService,
  scheduleTicketService,
  travelBetweenTicketsService,
} from "@/server/core/operations/dispatch-service";
import {
  activateContractService,
  createContractService,
  dueRenewalsService,
  getContractService,
  listContractsService,
} from "@/server/core/operations/renewal-service";
import {
  acknowledgeSyncOutcomesService,
  pendingSyncOutcomesService,
  runFieldWrite,
} from "@/server/core/operations/field-sync";
import {
  bookCourierService,
  completeDeliveryService,
  deliverableLinesForTicketService,
  todaysDropsService,
  getDeliveryFlowService,
  issueDeliveryReceiptService,
  logDeliveryAttemptService,
  mobilizeDeliveryService,
  recordCourierPodService,
  setDeliveryModeService,
  startDeliveryFlowService,
} from "@/server/core/operations/delivery-service";
import {
  CRITERION_SOURCES,
  LOOP_RESULTS,
  PUNCH_SEVERITIES,
  TC_RESULTS,
} from "@/server/core/operations/tc-rules";
import {
  beginTcService,
  completeTcService,
  listTcForTicketService,
  promisedLinesForTicketService,
  saveTcService,
} from "@/server/core/operations/tc-service";
import {
  ATTRIBUTION,
  COVERAGE,
  ROOT_CAUSE_CATEGORIES,
} from "@/server/core/operations/warranty-rules";
import {
  determineWarrantyClaimService,
  listEquipmentService,
  listWarrantyClaimsService,
  raiseWarrantyClaimService,
  upsertEquipmentService,
  warrantyReportService,
} from "@/server/core/operations/warranty-service";
import { ATTENDEE_PARTIES } from "@/server/core/operations/site-inspection-rules";
import { SERVICE_REPORT_STATUSES } from "@/server/core/operations/close-out-rules";
import {
  advanceServiceReportService,
  discardServiceReportService,
  recordExternalServiceReportService,
  closeOutChecklistForProjectService,
  closeOutProjectService,
  getProjectService,
  listProjectsService,
  listServiceReportsForTicketService,
  saveServiceReportService,
  upsertCloseOutService,
} from "@/server/core/operations/close-out-service";
import {
  listProgressService,
  logDayService,
  standbyEvidenceService,
  stepsForTicketService,
} from "@/server/core/operations/daily-progress-service";
import {
  demobilizeService,
  departService,
  getMobilizationService,
  listMobilizationsService,
  planMobilizationService,
  readinessForTicketService,
  startWorkService,
  updateMobilizationService,
} from "@/server/core/operations/mobilization-service";
import {
  adjustStockService,
  approveMaterialRequestService,
  createMaterialRequestService,
  getMaterialRequestService,
  issueMaterialsService,
  listMaterialRequestsService,
  listStockService,
  markMaterialsNotApplicableService,
  materialGateForTicket,
  outstandingCustodyService,
  returnMaterialsService,
  submitMaterialRequestService,
  upsertStockItemService,
} from "@/server/core/operations/material-request-service";
import {
  approveMethodologyService,
  createMethodologyService,
  getMethodologyService,
  listMethodologiesService,
  listReusableMethodologiesService,
  methodologyGateForTicket,
  overrideMethodologyGateService,
  recordClientDecisionService,
  recordExternalMethodologyService,
  saveMethodologyService,
  submitForInternalReviewService,
  submitToClientService,
  withdrawFromClientService,
  waiveClientApprovalService,
} from "@/server/core/operations/methodology-service";
import {
  approveInspectionService,
  completeInspectionService,
  getInspectionService,
  inspectionWaiverForTicket,
  listInspectionsService,
  setInspectionWaiverService,
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
        attendees: z
          .array(
            z.object({
              party: z.enum(ATTENDEE_PARTIES),
              name: z.string().max(200).nullish(),
            }),
          )
          .optional(),
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
  /**
   * §6.1's sign-off. `ticket.execute` at the door; the real rule is in the service, because being
   * the person who asked for the survey is as good as holding `project.manage` here.
   */
  approveInspection: p("ticket.execute")
    .input(z.object({ inspectionId: z.string() }))
    .mutation(({ ctx, input }) =>
      approveInspectionService(ctx.user, actorMeta(ctx), input.inspectionId),
    ),

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

  /**
   * Whether somebody has recorded that this job needs no site survey.
   *
   * A read, and a cheap one, so it sits on `ticket.view` with everything else on the ticket. The
   * *setting* of it is a dispatcher decision — see below.
   */
  inspectionWaiver: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => inspectionWaiverForTicket(input.ticketId)),

  /**
   * Record that no survey is needed, or withdraw that.
   *
   * Gated on `ticket.dispatch` rather than `ticket.execute`: deciding a site does not need looking
   * at is a planning call, and the person who would have gone is not the person to excuse the trip.
   *
   * The 10-character floor is enforced in the service too. Doing it in both places is deliberate —
   * the schema gives the browser a usable error, the service is what makes it true.
   */
  setInspectionWaiver: p("ticket.dispatch")
    .input(
      z.object({
        ticketId: z.string(),
        waived: z.boolean(),
        reason: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setInspectionWaiverService(actorMeta(ctx), input)),

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

  /** The undo for a mis-click. Narrow by design — see withdrawFromClientService. */
  withdrawMethodologyFromClient: p("methodology.prepare")
    .input(z.object({ methodologyId: z.string() }))
    .mutation(({ ctx, input }) => withdrawFromClientService(actorMeta(ctx), input.methodologyId)),

  /**
   * §6.2's second path: the client's own method statement, already approved.
   *
   * On `methodology.prepare` rather than `methodology.approve`, and the distinction is the point.
   * Nobody at AIES is approving anything here — the client already did, on their own paper. What
   * this records is *that it happened*, which is the same act as preparing a statement and belongs
   * with the same people. Requiring an approver would imply an AIES decision that nobody made.
   *
   * The service refuses when a method statement is already live on the job, which is what stops
   * this being a way around the internal review rather than an alternative to it.
   */
  recordExternalMethodology: p("methodology.prepare")
    .input(
      z.object({
        ticketId: z.string(),
        title: z.string().max(300),
        scopeSummary: z.string().min(1).max(2000),
        approvalFileId: z.string(),
        clientApprovedByName: z.string().min(1).max(200),
        clientApprovedByPosition: z.string().max(200).nullish(),
        clientApprovedAt: z.coerce.date(),
      }),
    )
    .mutation(({ ctx, input }) => recordExternalMethodologyService(actorMeta(ctx), input)),

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

  // ---- §7's material request --------------------------------------------------------------------

  createMaterialRequest: p("material_request.raise")
    .input(
      z.object({
        ticketId: z.string(),
        projectId: z.string().nullish(),
        neededBy: z.coerce.date().nullish(),
        fromMethodologyId: z.string().nullish(),
        lines: z
          .array(
            z.object({
              itemType: z.enum(ITEM_TYPES),
              stockItemId: z.string().nullish(),
              description: z.string().min(1).max(300),
              quantity: z.number().positive(),
              unit: z.string().max(30).default("pc"),
              source: z.enum(SOURCES),
              notes: z.string().max(500).nullish(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => createMaterialRequestService(actorMeta(ctx), input)),

  /**
   * §7's middle answer. A call rather than a field, so the audit row records who decided —
   * "`N/A` is a legitimate, recorded answer, not a skipped step".
   */
  markMaterialsNotApplicable: p("material_request.raise")
    .input(z.object({ ticketId: z.string(), note: z.string().max(500).optional() }))
    .mutation(({ ctx, input }) => markMaterialsNotApplicableService(actorMeta(ctx), input)),

  submitMaterialRequest: p("material_request.raise")
    .input(z.object({ requestId: z.string() }))
    .mutation(({ ctx, input }) => submitMaterialRequestService(actorMeta(ctx), input.requestId)),

  approveMaterialRequest: p("material_request.approve")
    .input(
      z.object({
        requestId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => approveMaterialRequestService(actorMeta(ctx), input)),

  /** The store hands over. An out-of-calibration instrument is refused here, not warned about. */
  issueMaterials: p("material_request.issue")
    .input(
      z.object({
        requestId: z.string(),
        lines: z
          .array(
            z.object({
              lineNo: z.number().int().positive(),
              quantity: z.number().positive(),
              calibrationAssetId: z.string().nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(({ ctx, input }) => issueMaterialsService(actorMeta(ctx), input)),

  returnMaterials: p("material_request.issue")
    .input(
      z.object({
        requestId: z.string(),
        lines: z
          .array(
            z.object({
              lineNo: z.number().int().positive(),
              returned: z.number().nonnegative().optional(),
              consumed: z.number().nonnegative().optional(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(({ ctx, input }) => returnMaterialsService(actorMeta(ctx), input)),

  materialGate: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => materialGateForTicket(input.ticketId)),

  listMaterialRequests: p("ticket.view")
    .input(z.object({ ticketId: z.string().optional(), status: z.string().optional() }).optional())
    .query(({ input }) => listMaterialRequestsService(input ?? {})),

  getMaterialRequest: p("ticket.view")
    .input(z.object({ requestId: z.string() }))
    .query(({ input }) => getMaterialRequestService(input.requestId)),

  /** §7: "Tools disappear otherwise; this is universal." */
  outstandingCustody: p("material_request.issue").query(() => outstandingCustodyService()),

  listStock: p("ticket.view")
    .input(z.object({ search: z.string().optional() }).optional())
    .query(({ ctx, input }) => listStockService(ctx.user, input ?? {})),

  upsertStockItem: p("material_request.issue")
    .input(
      z.object({
        id: z.string().nullish(),
        sku: z.string().min(1).max(60),
        name: z.string().min(1).max(200),
        category: z.string().max(60).default("consumable"),
        unit: z.string().max(30).default("pc"),
        qtyOnHand: z.number().nonnegative().optional(),
        reorderLevel: z.number().nonnegative().optional(),
        location: z.string().max(120).nullish(),
        calibrationDueAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => upsertStockItemService(actorMeta(ctx), input)),

  // ---- §8's mobilisation ------------------------------------------------------------------------

  /**
   * §8's green/red list, assembled from §5, §6.2 and §7's gates.
   *
   * A query on `ticket.view` rather than `ticket.dispatch`: everybody who can see the ticket should
   * be able to see why it is not going anywhere. Only dispatching is restricted.
   */
  mobilizationReadiness: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => readinessForTicketService(input.ticketId)),

  planMobilization: p("ticket.dispatch")
    .input(
      z.object({
        ticketId: z.string(),
        type: z.enum(MOBILIZATION_TYPES),
        plannedAt: z.coerce.date().nullish(),
        crewIds: z.array(z.string()).optional(),
        vehicleRef: z.string().max(120).nullish(),
        driverName: z.string().max(120).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => planMobilizationService(actorMeta(ctx), input)),

  updateMobilization: p("ticket.dispatch")
    .input(
      z.object({
        mobilizationId: z.string(),
        plannedAt: z.coerce.date().nullish(),
        crewIds: z.array(z.string()).optional(),
        vehicleRef: z.string().max(120).nullish(),
        driverName: z.string().max(120).nullish(),
        toolsChecklist: z
          .array(
            z.object({
              label: z.string().max(200),
              checked: z.boolean(),
              note: z.string().max(300).optional(),
            }),
          )
          .optional(),
        ppeChecklist: z
          .array(
            z.object({
              label: z.string().max(200),
              checked: z.boolean(),
              note: z.string().max(300).optional(),
            }),
          )
          .optional(),
        gatePassStatus: z.enum(CLEARANCE_STATES).optional(),
        permitStatus: z.enum(CLEARANCE_STATES).optional(),
        inductionCompleted: z.boolean().optional(),
        departureOdometer: z.number().int().nonnegative().nullish(),
        arrivalOdometer: z.number().int().nonnegative().nullish(),
        notes: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => updateMobilizationService(actorMeta(ctx), input)),

  /** Refuses unless every mandatory readiness item passes — §8 says `ready_to_mobilize` requires it. */
  depart: p("ticket.dispatch")
    .input(z.object({ mobilizationId: z.string() }))
    .mutation(({ ctx, input }) => departService(actorMeta(ctx), input.mobilizationId)),

  startWork: p("ticket.dispatch")
    .input(z.object({ mobilizationId: z.string() }))
    .mutation(({ ctx, input }) => startWorkService(actorMeta(ctx), input.mobilizationId)),

  /** Closes §5's liquidation deadline and §7's tool-return date onto the real demobilisation date. */
  demobilize: p("ticket.dispatch")
    .input(
      z.object({
        mobilizationId: z.string(),
        arrivalOdometer: z.number().int().nonnegative().nullish(),
        notes: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => demobilizeService(actorMeta(ctx), input)),

  listMobilizations: p("ticket.view")
    .input(z.object({ ticketId: z.string().optional(), status: z.string().optional() }).optional())
    .query(({ input }) => listMobilizationsService(input ?? {})),

  // ---- §8's execution half ------------------------------------------------------------------------

  /**
   * One day on site. Upserts on (ticket, date): a second log for one day is a correction of the
   * first, never a second account of it.
   */
  logDay: p("ticket.execute")
    .input(
      z.object({
        ticketId: z.string(),
        logDate: z.coerce.date(),
        stepsCompleted: z.array(z.number().int().positive()).optional(),
        percentComplete: z.number().int().min(0).max(100),
        manpowerOnSite: z.number().int().nonnegative(),
        hoursWorked: z.number().nonnegative(),
        weather: z.string().max(120).nullish(),
        standbyHours: z.number().nonnegative().optional(),
        standbyCause: z.enum(STANDBY_CAUSES).nullish(),
        standbyNotes: z.string().max(2000).nullish(),
        issuesRaised: z.string().max(5000).nullish(),
        notes: z.string().max(5000).nullish(),
        photoFileIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => logDayService(actorMeta(ctx), input)),

  /** The method statement's steps, so progress is logged against the sequence rather than guessed. */
  progressSteps: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => stepsForTicketService(input.ticketId)),

  listProgress: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listProgressService(input.ticketId)),

  /** §8: "the evidence base for a variation claim, and today it exists only in people's memory". */
  standbyEvidence: p("ticket.view")
    .input(z.object({ ticketId: z.string().optional(), projectId: z.string().optional() }))
    .query(({ input }) => standbyEvidenceService(input)),

  // ---- §9's client QA gate ------------------------------------------------------------------------

  /**
   * Records the client's verdict. §9: "QA is performed and approved by the client, not by AIES."
   *
   * The evidence requirement is enforced in the service as well as the form, because §9 calls it a
   * hard block and a rule living only in a React component is one a network tab walks past.
   */
  recordQa: p("qa.record")
    .input(
      z.object({
        ticketId: z.string(),
        approved: z.boolean(),
        clientInspected: z.boolean().optional(),
        inspectedAt: z.coerce.date().nullish(),
        clientInspectorName: z.string().max(200).nullish(),
        clientInspectorPosition: z.string().max(200).nullish(),
        evidenceFileIds: z.array(z.string()).optional(),
        evidenceType: z.enum(EVIDENCE_TYPES).nullish(),
        remarks: z.string().max(5000).nullish(),
        defects: z
          .array(
            z.object({
              description: z.string().min(1).max(1000),
              severity: z.enum(DEFECT_SEVERITIES),
              ownerId: z.string().nullish(),
              dueAt: z.string().nullish(),
              status: z.string().max(40).optional(),
              photoFileIds: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordQaService(actorMeta(ctx), input)),

  listQa: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listQaForTicketService(input.ticketId)),

  /** §9's "quality metric that matters most and is currently unmeasurable". */
  firstTimeRight: p("ticket.view")
    .input(z.object({ projectId: z.string().optional() }).optional())
    .query(({ input }) => firstTimeRightService(input ?? {})),

  getMobilization: p("ticket.view")
    .input(z.object({ mobilizationId: z.string() }))
    .query(({ input }) => getMobilizationService(input.mobilizationId)),

  /**
   * §10's commissioning record.
   *
   * `criterionSetAt` and `measuredAt` are deliberately **not** accepted from the client — the
   * service stamps both. A provenance field the caller can write is decoration, and provenance is
   * the whole of what makes §10's out-of-spec flag mean anything. docs/DECISIONS.md #69.
   */
  beginTc: p("ticket.execute")
    .input(z.object({ ticketId: z.string() }))
    .mutation(({ ctx, input }) => beginTcService(actorMeta(ctx), input)),

  saveTc: p("ticket.execute")
    .input(
      z.object({
        id: z.string(),
        functionalTests: z
          .array(
            z.object({
              test: z.string().min(1).max(300),
              criterion: z
                .discriminatedUnion("kind", [
                  z.object({ kind: z.literal("min"), min: z.number() }),
                  z.object({ kind: z.literal("max"), max: z.number() }),
                  z.object({ kind: z.literal("range"), min: z.number(), max: z.number() }),
                  z.object({
                    kind: z.literal("nominal"),
                    nominal: z.number(),
                    tolerance: z.number(),
                    toleranceKind: z.enum(["absolute", "percent"]),
                  }),
                  z.object({
                    kind: z.literal("qualitative"),
                    expected: z.string().min(1).max(500),
                  }),
                ])
                .nullish(),
              criterionSource: z.enum(CRITERION_SOURCES).optional(),
              quotationLineId: z.string().nullish(),
              promiseText: z.string().max(2000).nullish(),
              measured: z.union([z.string().max(200), z.number()]).nullish(),
              unit: z.string().max(40).nullish(),
              remarks: z.string().max(2000).nullish(),
            }),
          )
          .optional(),
        performanceVerification: z
          .array(
            z.object({
              test: z.string().min(1).max(300),
              criterion: z
                .discriminatedUnion("kind", [
                  z.object({ kind: z.literal("min"), min: z.number() }),
                  z.object({ kind: z.literal("max"), max: z.number() }),
                  z.object({ kind: z.literal("range"), min: z.number(), max: z.number() }),
                  z.object({
                    kind: z.literal("nominal"),
                    nominal: z.number(),
                    tolerance: z.number(),
                    toleranceKind: z.enum(["absolute", "percent"]),
                  }),
                  z.object({
                    kind: z.literal("qualitative"),
                    expected: z.string().min(1).max(500),
                  }),
                ])
                .nullish(),
              criterionSource: z.enum(CRITERION_SOURCES).optional(),
              quotationLineId: z.string().nullish(),
              promiseText: z.string().max(2000).nullish(),
              measured: z.union([z.string().max(200), z.number()]).nullish(),
              unit: z.string().max(40).nullish(),
              remarks: z.string().max(2000).nullish(),
            }),
          )
          .optional(),
        loopChecks: z
          .array(
            z.object({
              tagNumber: z.string().min(1).max(120),
              loopId: z.string().max(120).nullish(),
              result: z.enum(LOOP_RESULTS),
              remarks: z.string().max(2000).nullish(),
            }),
          )
          .optional(),
        punchItems: z
          .array(
            z.object({
              description: z.string().min(1).max(1000),
              severity: z.enum(PUNCH_SEVERITIES),
              ownerId: z.string().nullish(),
              dueAt: z.string().nullish(),
              status: z.string().max(40).optional(),
            }),
          )
          .optional(),
        calibrationAssetsUsed: z.array(z.string()).optional(),
        trainingDelivered: z
          .array(
            z.object({
              topic: z.string().min(1).max(300),
              attendees: z.array(z.string()).optional(),
              durationHours: z.number().nonnegative().optional(),
              materialsFileId: z.string().nullish(),
            }),
          )
          .optional(),
        witnessedByCustomer: z.boolean().optional(),
        customerWitnessName: z.string().max(200).nullish(),
        customerWitnessPosition: z.string().max(200).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => saveTcService(actorMeta(ctx), input)),

  /** §19 gives sign-off its own permission: §10's certificate is a billing trigger. */
  completeTc: p("tc.signoff")
    .input(
      z.object({
        id: z.string(),
        result: z.enum(TC_RESULTS),
        remarks: z.string().max(5000).nullish(),
        customerSignatureFileId: z.string().nullish(),
        signOffRemarks: z.string().max(5000).nullish(),
        certificateFileId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => completeTcService(actorMeta(ctx), input)),

  listTc: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listTcForTicketService(input.ticketId)),

  /** What the accepted quotation promised, so a criterion can cite a line rather than be invented. */
  promisedLines: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => promisedLinesForTicketService(input.ticketId)),

  /**
   * §11's warranty callback.
   *
   * Coverage and attribution are two answers, not one — §11 makes an AIES-caused defect
   * non-billable and an NCR whether or not the window has closed. docs/DECISIONS.md #71.
   */
  raiseWarrantyClaim: p("warranty.determine")
    .input(
      z.object({
        accountId: z.string(),
        equipmentId: z.string().nullish(),
        originalProjectId: z.string().nullish(),
        originalTicketId: z.string().nullish(),
        faultDescription: z.string().min(1).max(5000),
        coverage: z.enum(COVERAGE).optional(),
        attribution: z.enum(ATTRIBUTION).optional(),
        rootCause: z.string().max(2000).nullish(),
        rootCauseCategory: z.enum(ROOT_CAUSE_CATEGORIES).nullish(),
        coverageOverrideReason: z.string().max(2000).nullish(),
        remarks: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => raiseWarrantyClaimService(actorMeta(ctx), input)),

  /** Answers a claim left open because nobody could say who paid. */
  determineWarrantyClaim: p("warranty.determine")
    .input(
      z.object({
        id: z.string(),
        coverage: z.enum(COVERAGE),
        attribution: z.enum(ATTRIBUTION),
        rootCause: z.string().max(2000).nullish(),
        rootCauseCategory: z.enum(ROOT_CAUSE_CATEGORIES).nullish(),
        coverageOverrideReason: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => determineWarrantyClaimService(actorMeta(ctx), input)),

  listWarrantyClaims: p("ticket.view")
    .input(
      z
        .object({
          accountId: z.string().optional(),
          projectId: z.string().optional(),
          openOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => listWarrantyClaimsService(input ?? {})),

  /** §11: "Warranty cost that nobody totals is warranty cost that never gets fixed." */
  warrantyReport: p("ticket.view")
    .input(z.object({ accountId: z.string().optional() }).optional())
    .query(({ input }) => warrantyReportService(input ?? {})),

  listEquipment: p("ticket.view")
    .input(z.object({ accountId: z.string().optional() }).optional())
    .query(({ input }) => listEquipmentService(input ?? {})),

  upsertEquipment: p("equipment.manage")
    .input(
      z.object({
        id: z.string().optional(),
        accountId: z.string(),
        siteId: z.string().nullish(),
        description: z.string().min(1).max(500),
        serialNumber: z.string().max(200).nullish(),
        tagNumber: z.string().max(200).nullish(),
        manufacturer: z.string().max(200).nullish(),
        modelNumber: z.string().max(200).nullish(),
        installedAt: z.coerce.date().nullish(),
        installedByTicketId: z.string().nullish(),
        commissionedAt: z.coerce.date().nullish(),
        commissionedByTcId: z.string().nullish(),
        warrantyStart: z.coerce.date().nullish(),
        warrantyEnd: z.coerce.date().nullish(),
        warrantyTerms: z.string().max(2000).nullish(),
        location: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => upsertEquipmentService(actorMeta(ctx), input)),

  saveServiceReport: p("ticket.execute")
    .input(
      z.object({
        id: z.string().optional(),
        ticketId: z.string(),
        workPerformed: z.string().min(1).max(20000),
        findings: z.string().max(20000).nullish(),
        recommendations: z.string().max(20000).nullish(),
        partsUsed: z
          .array(
            z.object({
              description: z.string().min(1).max(500),
              partNumber: z.string().max(200).nullish(),
              quantity: z.number().positive(),
              unit: z.string().max(40).nullish(),
              fromStock: z.boolean().optional(),
              stockItemId: z.string().nullish(),
            }),
          )
          .optional(),
        equipmentIds: z.array(z.string()).optional(),
        startedAt: z.coerce.date().nullish(),
        finishedAt: z.coerce.date().nullish(),
        travelTimeMin: z.number().int().nonnegative().nullish(),
        standbyTimeMin: z.number().int().nonnegative().nullish(),
        photoFileIds: z.array(z.string()).optional(),
        followUpRequired: z.boolean().optional(),
        followUpNotes: z.string().max(5000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => saveServiceReportService(actorMeta(ctx), input)),

  /**
   * §19 gives approval its own permission. The customer signs what the technician wrote; somebody at
   * AIES then stands behind it. One click doing both would collapse two different claims.
   */
  advanceServiceReport: p("service_report.approve")
    .input(
      z.object({
        id: z.string(),
        target: z.enum(SERVICE_REPORT_STATUSES),
        customerSignatureFileId: z.string().nullish(),
        customerName: z.string().max(200).nullish(),
        customerPosition: z.string().max(200).nullish(),
        customerRemarks: z.string().max(5000).nullish(),
        signatureWaiverReason: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => advanceServiceReportService(actorMeta(ctx), input)),

  /**
   * Throw away a report that should not have been written.
   *
   * On `ticket.execute` rather than `service_report.approve`: the person who wrote it is the person
   * who knows it is wrong, and making them find an approver to delete their own typo is how a bad
   * draft ends up being approved instead. The service refuses once the customer has signed.
   */
  discardServiceReport: p("ticket.execute")
    .input(z.object({ id: z.string(), reason: z.string().min(10).max(1000) }))
    .mutation(({ ctx, input }) => discardServiceReportService(actorMeta(ctx), input)),

  /**
   * §12's second path: a service report written on an externally supplied form, already signed.
   *
   * On `ticket.execute` rather than `service_report.approve`, and the reasoning is the same as the
   * method statement's twin: nobody at AIES is approving the work here — the customer signed for it
   * on site. What is being recorded is that it happened, and the person who was there is the person
   * who knows. Requiring an approver would imply an AIES decision nobody made, and would keep the
   * technician standing at a gate holding the signed paper.
   */
  recordExternalServiceReport: p("ticket.execute")
    .input(
      z.object({
        ticketId: z.string(),
        workPerformed: z.string().min(1).max(5000),
        signatureFileId: z.string(),
        customerName: z.string().min(1).max(200),
        customerPosition: z.string().max(200).nullish(),
        finishedAt: z.coerce.date(),
      }),
    )
    .mutation(({ ctx, input }) => recordExternalServiceReportService(actorMeta(ctx), input)),

  listServiceReports: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listServiceReportsForTicketService(input.ticketId)),

  /** §12's blockers, computed from what the other sections recorded rather than ticked by hand. */
  closeOutChecklist: p("ticket.view")
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => closeOutChecklistForProjectService(input.projectId)),

  upsertCloseOut: p("project.manage")
    .input(
      z.object({
        projectId: z.string(),
        customerAcceptanceRequired: z.boolean().optional(),
        customerAcceptanceFileId: z.string().nullish(),
        acceptanceDate: z.coerce.date().nullish(),
        acceptanceWaiverReason: z.string().max(2000).nullish(),
        lessonsLearned: z.string().max(20000).nullish(),
        documentIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => upsertCloseOutService(actorMeta(ctx), input)),

  /** §12: closing emits `project.closed`, which is what releases final billing in module 05. */
  closeOutProject: p("project.close")
    .input(z.object({ projectId: z.string(), lessonsLearned: z.string().max(20000).nullish() }))
    .mutation(({ ctx, input }) => closeOutProjectService(actorMeta(ctx), input)),

  listProjects: p("project.view")
    .input(z.object({ status: z.string().optional() }).optional())
    .query(({ input }) => listProjectsService(input ?? {})),

  getProject: p("project.view")
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getProjectService(input.projectId)),

  // ---- §13's delivery lane ----------------------------------------------------------------------

  /**
   * The whole lane reads through one query, because the panel's shape depends on the mode and the
   * status together and two round trips would let them disagree on screen.
   */
  getDeliveryFlow: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => getDeliveryFlowService(input.ticketId)),

  /** What the DR should say, taken from the order rather than retyped. */
  deliverableLines: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => deliverableLinesForTicketService(input.ticketId)),

  /** §14's delivery mode. Everything a driver needs before setting off, and nothing else. */
  todaysDrops: p("delivery.execute").query(() => todaysDropsService()),

  startDeliveryFlow: p("delivery.execute")
    .input(z.object({ ticketId: z.string(), mode: z.enum(DELIVERY_MODES).optional() }))
    .mutation(({ ctx, input }) => startDeliveryFlowService(actorMeta(ctx), input)),

  setDeliveryMode: p("delivery.execute")
    .input(z.object({ ticketId: z.string(), mode: z.enum(DELIVERY_MODES) }))
    .mutation(({ ctx, input }) => setDeliveryModeService(actorMeta(ctx), input)),

  /** Module 03 §7's document, issued only through the ticket that will execute it. */
  issueDeliveryReceipt: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        salesOrderId: z.string(),
        siteId: z.string().nullish(),
        lines: z
          .array(
            z.object({
              salesOrderLineId: z.string(),
              description: z.string().min(1).max(2000),
              quantity: z.string().min(1).max(40),
              unit: z.string().min(1).max(40),
            }),
          )
          .min(1),
      }),
    )
    .mutation(({ ctx, input }) => issueDeliveryReceiptService(actorMeta(ctx), input)),

  mobilizeDelivery: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        vehicleRef: z.string().max(200).nullish(),
        driverName: z.string().max(200).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => mobilizeDeliveryService(actorMeta(ctx), input)),

  /**
   * One visit, successful or not. `failureReason` is optional to the schema and required by the
   * rules whenever the visit failed — the message a driver needs there is longer than
   * "Required", and it belongs next to §13's list of causes rather than in a zod error.
   */
  logDeliveryAttempt: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        contactPersonSought: z.string().max(200).nullish(),
        contactReached: z.boolean(),
        itemDelivered: z.boolean(),
        drSigned: z.boolean(),
        failureReason: z.enum(ATTEMPT_FAILURE_CAUSES).nullish(),
        photoFileIds: z.array(z.string()).optional(),
        geo: z.object({ lat: z.number(), lng: z.number() }).nullish(),
        notes: z.string().max(5000).nullish(),
        recipientName: z.string().max(200).nullish(),
        recipientPosition: z.string().max(200).nullish(),
        signatureFileId: z.string().nullish(),

        /**
         * §14's outbox id, generated on the device before the write is attempted.
         *
         * Optional, so the same procedure serves both callers: a dispatcher clicking in the office
         * sends none and the write runs directly, while a phone replaying its queue sends one and
         * gets exactly-once semantics. Two procedures would have meant two code paths to the same
         * business rules, and the offline one would be the one nobody exercised until it mattered.
         */
        clientUuid: z.string().uuid().optional(),
        capturedAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { clientUuid, capturedAt, ...attempt } = input;
      if (!clientUuid) return logDeliveryAttemptService(actorMeta(ctx), attempt);

      return runFieldWrite({
        clientUuid,
        userId: ctx.user.id,
        operation: "delivery.attempt",
        payload: attempt,
        capturedAt,
        run: async () => {
          const result = await logDeliveryAttemptService(actorMeta(ctx), attempt);
          return { result, entityType: "DeliveryTicketFlow", entityId: attempt.ticketId };
        },
      });
    }),

  /**
   * What the device still has to tell its user about work it queued.
   *
   * Not gated on `delivery.execute` or any other field permission: this returns only rows belonging
   * to the caller, and somebody whose permissions changed after they queued work still needs to be
   * told what happened to it. Gating it would mean the one person who must see a rejection is the
   * one who cannot.
   */
  pendingSyncOutcomes: protectedProcedure.query(({ ctx }) =>
    pendingSyncOutcomesService(ctx.user.id),
  ),

  acknowledgeSyncOutcomes: protectedProcedure
    .input(z.object({ submissionIds: z.array(z.string()).max(200) }))
    .mutation(({ ctx, input }) => acknowledgeSyncOutcomesService(ctx.user.id, input.submissionIds)),

  bookCourier: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        courierName: z.string().min(1).max(200),
        waybillNumber: z.string().min(1).max(120),
        trackingUrl: z.string().url().max(2000).nullish(),
        freightCost: z.number().int().nonnegative().nullish(),
        insuredValue: z.number().int().nonnegative().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => bookCourierService(actorMeta(ctx), input)),

  /** Deliberately not a completion. §13.2 step 5, and the reason the lane has nine statuses. */
  recordCourierPod: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        courierPodFileId: z.string(),
        courierRecipientName: z.string().max(200).nullish(),
        deliveredAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => recordCourierPodService(actorMeta(ctx), input)),

  completeDelivery: p("delivery.execute")
    .input(
      z.object({
        ticketId: z.string(),
        recipientName: z.string().min(1).max(200),
        recipientPosition: z.string().max(200).nullish(),
        signatureFileId: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => completeDeliveryService(actorMeta(ctx), input)),

  // ---- §15's checklists ---------------------------------------------------------------------

  listChecklistTemplates: p("ticket.view")
    .input(
      z.object({ stage: z.string().optional(), includeRetired: z.boolean().optional() }).optional(),
    )
    .query(({ input }) => listTemplatesService(input ?? {})),

  activeChecklistTemplate: p("ticket.view")
    .input(z.object({ key: z.string() }))
    .query(({ input }) => activeTemplateService(input.key)),

  createChecklistTemplate: p("checklist.manage")
    .input(
      z.object({
        key: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        stage: z.string().min(1).max(80),
        description: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createTemplateService(actorMeta(ctx), input)),

  /** Only a draft. A published version is the procedure of record and cannot be rewritten. */
  saveChecklistDraft: p("checklist.manage")
    .input(
      z.object({
        templateId: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullish(),
        sections: z
          .array(
            z.object({
              key: z.string().min(1).max(80),
              title: z.string().min(1).max(200),
              items: z.array(
                z.object({
                  key: z.string().min(1).max(80),
                  label: z.string().min(1).max(300),
                  type: z.enum(CHECKLIST_ITEM_TYPES),
                  required: z.boolean().optional(),
                  min: z.number().nullish(),
                  max: z.number().nullish(),
                  unit: z.string().max(30).nullish(),
                  options: z.array(z.string().max(120)).optional(),
                  help: z.string().max(500).nullish(),
                }),
              ),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => saveDraftService(actorMeta(ctx), input)),

  publishChecklistTemplate: p("checklist.manage")
    .input(z.object({ templateId: z.string() }))
    .mutation(({ ctx, input }) => publishTemplateService(actorMeta(ctx), input)),

  reviseChecklistTemplate: p("checklist.manage")
    .input(z.object({ templateId: z.string() }))
    .mutation(({ ctx, input }) => reviseTemplateService(actorMeta(ctx), input)),

  startChecklist: p("checklist.fill")
    .input(
      z.object({
        templateKey: z.string(),
        ticketId: z.string().nullish(),
        projectId: z.string().nullish(),
        entityType: z.string().nullish(),
        entityId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => startResponseService(actorMeta(ctx), input)),

  saveChecklistAnswers: p("checklist.fill")
    .input(z.object({ responseId: z.string(), answers: z.record(z.string(), z.unknown()) }))
    .mutation(({ ctx, input }) => saveAnswersService(actorMeta(ctx), input)),

  /**
   * Takes an optional `clientUuid`, exactly as §13's delivery attempt does — this is the write
   * §20's offline case names, and one procedure serves both the office and a phone replaying its
   * queue rather than two paths to the same rules.
   */
  completeChecklist: p("checklist.fill")
    .input(
      z.object({
        responseId: z.string(),
        signatureFileId: z.string().nullish(),
        signedByName: z.string().max(200).nullish(),
        signedByPosition: z.string().max(200).nullish(),
        clientUuid: z.string().uuid().optional(),
        capturedAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { clientUuid, capturedAt, ...completion } = input;
      if (!clientUuid) return completeResponseService(actorMeta(ctx), completion);

      return runFieldWrite({
        clientUuid,
        userId: ctx.user.id,
        operation: "checklist.complete",
        payload: completion,
        capturedAt,
        run: async () => ({
          result: await completeResponseService(actorMeta(ctx), completion),
          entityType: "ChecklistResponse",
          entityId: completion.responseId,
        }),
      });
    }),

  /**
   * Only an unfinished one. A signed checklist is the record of what was checked, and the service
   * refuses regardless of who is asking.
   */
  discardChecklist: p("checklist.fill")
    .input(z.object({ responseId: z.string() }))
    .mutation(({ ctx, input }) => deleteResponseService(actorMeta(ctx), input)),

  getChecklistResponse: p("ticket.view")
    .input(z.object({ responseId: z.string() }))
    .query(({ input }) => getResponseService(input.responseId)),

  listChecklistsForTicket: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listResponsesForTicketService(input.ticketId)),

  // ---- §16's hours, spend and installed base -----------------------------------------------------

  saveTimesheet: p("ticket.execute")
    .input(
      z.object({
        ticketId: z.string().nullish(),
        projectId: z.string().nullish(),
        date: z.coerce.date(),
        regularHours: z.number().min(0).max(24),
        overtimeHours: z.number().min(0).max(24).optional(),
        travelHours: z.number().min(0).max(24).optional(),
        standbyHours: z.number().min(0).max(24).optional(),
        activity: z.string().max(200).nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => saveTimesheetService(actorMeta(ctx), input)),

  submitTimesheets: p("ticket.execute")
    .input(z.object({ ids: z.array(z.string()).min(1).max(100) }))
    .mutation(({ ctx, input }) => submitTimesheetsService(actorMeta(ctx), input)),

  /** Never your own — the service refuses that whatever permissions the caller holds. */
  decideTimesheet: p("timesheet.approve")
    .input(
      z.object({
        id: z.string(),
        approve: z.boolean(),
        reason: z.string().max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => decideTimesheetService(actorMeta(ctx), input)),

  myTimesheets: protectedProcedure
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(({ ctx, input }) => myTimesheetsService(ctx.user.id, input.from, input.to)),

  timesheetsAwaiting: p("timesheet.approve").query(({ ctx }) =>
    timesheetsAwaitingService(ctx.user.id),
  ),

  ticketHours: p("ticket.view")
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => ticketHoursService(input.ticketId)),

  saveExpense: p("ticket.execute")
    .input(
      z.object({
        ticketId: z.string().nullish(),
        projectId: z.string().nullish(),
        cashAdvanceId: z.string().nullish(),
        date: z.coerce.date(),
        category: z.enum(EXPENSE_CATEGORIES),
        amount: z.number().int().positive(),
        description: z.string().min(1).max(2000),
        receiptFileIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => saveExpenseService(actorMeta(ctx), input)),

  submitExpenses: p("ticket.execute")
    .input(z.object({ ids: z.array(z.string()).min(1).max(100) }))
    .mutation(({ ctx, input }) => submitExpensesService(actorMeta(ctx), input)),

  decideExpense: p("timesheet.approve")
    .input(
      z.object({
        id: z.string(),
        approve: z.boolean(),
        reason: z.string().max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => decideExpenseService(actorMeta(ctx), input)),

  expensesAwaiting: p("timesheet.approve").query(({ ctx }) => expensesAwaitingService(ctx.user.id)),

  listExpenses: p("ticket.view")
    .input(
      z.object({
        ticketId: z.string().optional(),
        projectId: z.string().optional(),
        cashAdvanceId: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .query(({ input }) => listExpensesService(input)),

  /** §16's automatic flow into §5: released, less what has actually been approved. */
  advanceLiquidation: p("cash_advance.view_register")
    .input(z.object({ cashAdvanceId: z.string() }))
    .query(({ input }) => advanceLiquidationService(input.cashAdvanceId)),

  // ---- maintenance contracts and the renewal loop -------------------------------------------------

  listContracts: p("ticket.view")
    .input(z.object({ accountId: z.string().optional(), status: z.string().optional() }).optional())
    .query(({ input }) => listContractsService(input ?? {})),

  getContract: p("ticket.view")
    .input(z.object({ contractId: z.string() }))
    .query(({ input }) => getContractService(input.contractId)),

  createContract: p("contract.manage")
    .input(
      z.object({
        accountId: z.string(),
        siteId: z.string().nullish(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        visitsPerYear: z.number().int().min(1).max(52),
        equipmentIds: z.array(z.string()).optional(),
        contractValue: z.number().int().nonnegative().optional(),
        salesOrderId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createContractService(actorMeta(ctx), input)),

  activateContract: p("contract.manage")
    .input(z.object({ contractId: z.string() }))
    .mutation(({ ctx, input }) => activateContractService(actorMeta(ctx), input)),

  /**
   * What the nightly sweep will act on, without acting on it.
   *
   * The screen and the job share one function so a dashboard can never disagree with the thing
   * behind it — which is the failure mode of every "pending items" count built separately.
   */
  dueRenewals: p("ticket.view").query(() => dueRenewalsService()),

  // ---- §17's dispatch board ----------------------------------------------------------------------

  dispatchBoard: p("ticket.view")
    .input(z.object({ weekOf: z.coerce.date().optional() }).optional())
    .query(({ input }) => dispatchBoardService(input ?? {})),

  /** §17's "the number sales needs before promising a date", so sales can see it too. */
  capacity: p("ticket.view")
    .input(z.object({ weeks: z.number().int().min(1).max(12).optional() }).optional())
    .query(({ input }) => capacityService(input ?? {})),

  /**
   * Writes the schedule and returns what it broke. Conflicts are reported rather than refused —
   * a scheduler that says no teaches people to schedule around it, and then the board is wrong
   * about everything rather than about one day.
   */
  /**
   * What a booking would collide with, before it happens.
   *
   * The company's instruction: let the scheduler confirm or cancel. That needs the answer before the
   * write — an undo leaves a window where the board is wrong, and somebody who closes the tab
   * mid-decision leaves it wrong for good.
   */
  previewSchedule: p("ticket.dispatch")
    .input(
      z.object({
        ticketId: z.string(),
        scheduledStart: z.coerce.date(),
        scheduledEnd: z.coerce.date().nullish(),
        assignedLeadId: z.string().nullish(),
        assignedUserIds: z.array(z.string()).optional(),
      }),
    )
    .query(({ input }) => previewScheduleService(input)),

  scheduleTicket: p("ticket.dispatch")
    .input(
      z.object({
        ticketId: z.string(),
        scheduledStart: z.coerce.date().nullable(),
        scheduledEnd: z.coerce.date().nullish(),
        assignedLeadId: z.string().nullish(),
        assignedUserIds: z.array(z.string()).optional(),
        crewNote: z.string().max(300).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => scheduleTicketService(actorMeta(ctx), input)),

  bumpForEmergency: p("ticket.dispatch")
    .input(
      z.object({
        emergencyTicketId: z.string(),
        scheduledStart: z.coerce.date(),
        bumpTicketIds: z.array(z.string()).min(1).max(50),
      }),
    )
    .mutation(({ ctx, input }) => bumpForEmergencyService(actorMeta(ctx), input)),

  listUnavailability: p("ticket.view")
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(({ input }) => listUnavailabilityService(input)),

  recordUnavailability: p("ticket.dispatch")
    .input(
      z.object({
        userId: z.string(),
        fromDate: z.coerce.date(),
        toDate: z.coerce.date(),
        kind: z.enum(UNAVAILABILITY_KINDS),
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => recordUnavailabilityService(actorMeta(ctx), input)),

  removeUnavailability: p("ticket.dispatch")
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeUnavailabilityService(actorMeta(ctx), input)),

  travelBetweenTickets: p("ticket.view")
    .input(z.object({ fromTicketId: z.string(), toTicketId: z.string() }))
    .query(({ input }) => travelBetweenTicketsService(input)),

  adjustStock: p("material_request.issue")
    .input(
      z.object({
        stockItemId: z.string(),
        countedQty: z.number().nonnegative(),
        reference: z.string().max(200).optional(),
      }),
    )
    .mutation(({ ctx, input }) => adjustStockService(actorMeta(ctx), input)),
});
