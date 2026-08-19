import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  billableMilestonesService,
  cancelMilestoneService,
  generateScheduleService,
  getScheduleService,
} from "@/server/core/finance/billing-service";
import {
  bounceChequeService,
  cancelInvoiceService,
  cancelStatementService,
  clearChequeService,
  issueStatementService,
  outstanding2307sService,
  raiseStatementService,
  receivablesService,
  recordPaymentService,
} from "@/server/core/finance/invoice-service";
import { PAYMENT_METHODS, STATEMENT_TYPES, VAT_MODES } from "@/server/core/finance/invoice-rules";
import { finalBillingGate } from "@/server/core/finance/final-billing-gate";
import {
  collectionHistoryService,
  collectionWorklistService,
  creditExposureService,
  logCollectionActivityService,
  setRemindersEnabledService,
} from "@/server/core/finance/collection-service";
import {
  COLLECTION_ACTIVITY_TYPES,
  COLLECTION_OUTCOMES,
} from "@/server/core/finance/collection-rules";

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

  // ---- §3's two documents -----------------------------------------------------------------------

  /**
   * §4's gate as a checklist, for the statement draft screen.
   *
   * Read with `finance.view` rather than the issue permission: knowing what is holding up a bill is
   * useful to anybody who can see the finance screens, and making it visible only to whoever can
   * issue would put the person chasing operations behind a permission they do not need.
   */
  finalBillingGate: p("finance.view")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ input }) => finalBillingGate(input.salesOrderId)),

  /** §5's ageing, run on statements rather than invoices — see receivablesService for why. */
  receivables: p("ar.view").query(() => receivablesService()),

  /** §3.2's chase list. Unrecovered 2307s are money AIES has already earned and not collected. */
  outstanding2307s: p("ar.view").query(() => outstanding2307sService()),

  raiseStatement: p("billing_statement.create")
    .input(
      z.object({
        accountId: z.string(),
        type: z.enum(STATEMENT_TYPES).optional(),
        salesOrderId: z.string().nullish(),
        projectId: z.string().nullish(),
        ticketId: z.string().nullish(),
        milestoneId: z.string().nullish(),
        dueDate: z.coerce.date(),
        vatMode: z.enum(VAT_MODES).optional(),
        lines: z
          .array(
            z.object({
              description: z.string().min(1).max(500),
              quantity: z.union([z.string(), z.number()]),
              unitPrice: z.number().int(),
              vatable: z.boolean().optional(),
            }),
          )
          .min(1),
        poReference: z.string().max(120).nullish(),
        drReferences: z.array(z.string()).optional(),
        srReferences: z.array(z.string()).optional(),
        tcCertificateRef: z.string().max(120).nullish(),
        notes: z.string().max(2000).nullish(),
        terms: z.string().max(2000).nullish(),
        overrideGateReason: z.string().min(10).max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      /**
       * §4: the override is the president's and vice-president's alone.
       *
       * Checked here rather than by gating the whole procedure, because raising a statement is
       * finance's ordinary work and only *overriding the gate* is the officers' decision. One
       * procedure, two permissions — the second only when the first is being set aside.
       */
      if (
        input.overrideGateReason?.trim() &&
        !ctx.user.permissions.has("finance.override_billing_gate")
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the president or vice-president can raise a final statement past the billing gate.",
        });
      }
      return raiseStatementService(actorMeta(ctx), input);
    }),

  issueStatement: p("billing_statement.issue")
    .input(z.object({ statementId: z.string() }))
    .mutation(({ ctx, input }) => issueStatementService(actorMeta(ctx), input)),

  cancelStatement: p("billing_statement.issue")
    .input(z.object({ statementId: z.string(), reason: z.string().min(5).max(1000) }))
    .mutation(({ ctx, input }) => cancelStatementService(actorMeta(ctx), input)),

  /**
   * Recording a payment issues a BIR document. See the permission's note in the manifest — this is
   * the heaviest procedure in the module and it does not look it.
   */
  recordPayment: p("payment.record")
    .input(
      z.object({
        accountId: z.string(),
        receivedAt: z.coerce.date(),
        method: z.enum(PAYMENT_METHODS),
        amount: z.number().int().positive(),
        reference: z.string().max(200).nullish(),
        checkNumber: z.string().max(60).nullish(),
        checkDate: z.coerce.date().nullish(),
        withholdingTaxAmount: z.number().int().nonnegative().optional(),
        form2307FileId: z.string().nullish(),
        proofFileId: z.string().nullish(),
        notes: z.string().max(2000).nullish(),
        allocations: z
          .array(z.object({ billingStatementId: z.string(), amount: z.number().int().positive() }))
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordPaymentService(actorMeta(ctx), input)),

  clearCheque: p("payment.record")
    .input(z.object({ paymentId: z.string(), clearedAt: z.coerce.date().optional() }))
    .mutation(({ ctx, input }) => clearChequeService(actorMeta(ctx), input)),

  bounceCheque: p("payment.record")
    .input(z.object({ paymentId: z.string(), reason: z.string().min(3).max(500) }))
    .mutation(({ ctx, input }) => bounceChequeService(actorMeta(ctx), input)),

  // ---- §5's collections -------------------------------------------------------------------------

  /** The queue somebody works from each morning: what to chase first, and what was said last time. */
  collectionWorklist: p("ar.view")
    .input(z.object({ accountId: z.string().optional() }).optional())
    .query(({ input }) => collectionWorklistService(input ?? {})),

  collectionHistory: p("ar.view")
    .input(z.object({ statementId: z.string() }))
    .query(({ input }) => collectionHistoryService(input.statementId)),

  /**
   * §5's one-click follow-up.
   *
   * Gated on `ar.view` rather than a write permission: logging that you phoned somebody is not a
   * financial act, and putting it behind the permission to raise bills would mean whoever makes the
   * calls cannot record them — which is how a collection log stops being kept.
   */
  logCollectionActivity: p("ar.view")
    .input(
      z.object({
        statementId: z.string(),
        type: z.enum(COLLECTION_ACTIVITY_TYPES),
        notes: z.string().min(3).max(2000),
        contactId: z.string().nullish(),
        contactName: z.string().max(200).nullish(),
        promisedDate: z.coerce.date().nullish(),
        outcome: z.enum(COLLECTION_OUTCOMES).nullish(),
        contactedAt: z.coerce.date().optional(),
      }),
    )
    .mutation(({ ctx, input }) => logCollectionActivityService(actorMeta(ctx), input)),

  setRemindersEnabled: p("billing_statement.issue")
    .input(
      z.object({
        accountId: z.string(),
        enabled: z.boolean(),
        reason: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => setRemindersEnabledService(actorMeta(ctx), input)),

  /** §5's credit limit check, for the screen that raises an order. Warns; never blocks. */
  creditExposure: p("finance.view")
    .input(z.object({ accountId: z.string(), newOrderAmount: z.number().int().nonnegative() }))
    .query(({ input }) => creditExposureService(input)),

  cancelInvoice: p("invoice.cancel")
    .input(z.object({ serviceInvoiceId: z.string(), reason: z.string().min(5).max(1000) }))
    .mutation(({ ctx, input }) => cancelInvoiceService(actorMeta(ctx), input)),
});
