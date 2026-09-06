import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  chargeableProjectsService,
  decideExpenseService,
  expensesService,
  submitExpenseService,
} from "@/server/core/finance/expense-service";
import { EXPENSE_CATEGORIES } from "@/server/core/finance/expense-rules";
import {
  costRatesService,
  setCostRateService,
  uncostedDaysService,
} from "@/server/core/finance/cost-rate-service";
import { releaseQueueService } from "@/server/core/finance/cash-advance-queue";
import { projectPnlService } from "@/server/core/finance/project-pnl-service";
import {
  approveSupplierInvoiceService,
  payablesService,
  billableSuppliersService,
  recordSupplierInvoiceService,
} from "@/server/core/finance/payables-service";
import {
  exportHistoryService,
  previewExportService,
  recordExportService,
} from "@/server/core/finance/export-service";
import { EXPORT_DATASETS, EXPORT_PRESETS } from "@/server/core/finance/export-rules";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  askMilestoneReadinessService,
  billableMilestonesService,
  billingReadinessForOrderService,
  cancelMilestoneService,
  generateScheduleService,
  getScheduleService,
  recordCustomerBillingReplyService,
  releaseMilestoneService,
  replyMilestoneReadinessService,
} from "@/server/core/finance/billing-service";
import {
  bounceChequeService,
  cancelInvoiceService,
  cancelStatementService,
  clearChequeService,
  issueStatementService,
  pendingChequesService,
  recordForm2307Service,
  statementsService,
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
  setExpectedPaymentDateService,
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

  /**
   * docs/DECISIONS.md #184's "are we ready to bill this?" — releasing a `manual` milestone by hand,
   * because three of the eight payment terms bill on a judgement call nobody's status field can
   * prove. Gated the same as its sibling `cancelMilestone`: this is a decision about the schedule,
   * not an ordinary read of it.
   */
  releaseMilestone: p("billing_schedule.manage")
    .input(z.object({ milestoneId: z.string() }))
    .mutation(({ ctx, input }) => releaseMilestoneService(actorMeta(ctx), input)),

  /**
   * docs/DECISIONS.md #184's "100% Payment on Delivery" customer reply — logged by whoever at AIES
   * spoke to the customer, since there is no customer portal for them to answer through directly.
   */
  recordCustomerBillingReply: p("billing_schedule.manage")
    .input(
      z.object({
        milestoneId: z.string(),
        paymentReady: z.boolean(),
        preferredDeliveryDate: z.coerce.date().nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => recordCustomerBillingReplyService(actorMeta(ctx), input)),

  /**
   * docs/DECISIONS.md #185 — finance's half of the "are we ready to bill this?" exchange terms 4
   * through 6 need. Gated the same as every other schedule decision, not the issue permission:
   * asking is not billing.
   */
  askMilestoneReadiness: p("billing_schedule.manage")
    .input(z.object({ milestoneId: z.string() }))
    .mutation(({ ctx, input }) => askMilestoneReadinessService(actorMeta(ctx), input)),

  /**
   * Operations' half of the same exchange. `project.manage` rather than a finance permission —
   * this is the one place in the schedule an operations decision-maker can act, and it is the same
   * permission that already gates planning a project and signing off its site inspection.
   */
  replyMilestoneReadiness: p("project.manage")
    .input(
      z.object({
        milestoneId: z.string(),
        accomplished: z.boolean(),
        percentComplete: z.number().min(0).max(100).nullish(),
        estimatedDate: z.coerce.date().nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => replyMilestoneReadinessService(actorMeta(ctx), input)),

  /**
   * The read side for operations — `BillingPanel` shows finance the same fields, but that screen
   * sits behind `finance.view`, which an operations manager does not hold. Scoped to one order and
   * gated on `project.manage`, same as the reply.
   */
  billingReadinessForOrder: p("project.manage")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ input }) => billingReadinessForOrderService(input.salesOrderId)),

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

  /**
   * docs/DECISIONS.md #188's prompt — "when is payment expected?" — filled in by whoever at finance
   * or admin has spoken to the customer. Gated on `ar.view`, the same permission that already reaches
   * both audiences the cycle escalates to.
   */
  setExpectedPaymentDate: p("ar.view")
    .input(
      z.object({
        statementId: z.string(),
        expectedDate: z.coerce.date(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => setExpectedPaymentDateService(actorMeta(ctx), input)),

  /** §5's credit limit check, for the screen that raises an order. Warns; never blocks. */
  creditExposure: p("finance.view")
    .input(z.object({ accountId: z.string(), newOrderAmount: z.number().int().nonnegative() }))
    .query(({ input }) => creditExposureService(input)),

  cancelInvoice: p("invoice.cancel")
    .input(z.object({ serviceInvoiceId: z.string(), reason: z.string().min(5).max(1000) }))
    .mutation(({ ctx, input }) => cancelInvoiceService(actorMeta(ctx), input)),

  /**
   * §5b's release queue: approved advances waiting for the money, soonest needed first.
   *
   * On `cash_advance.view_register`, which operations already holds — §5b wants this visible to
   * them so nobody chases finance in a chat app. Releasing is `cash_advance.release` and stays
   * finance's; seeing the queue is not the same authority as emptying it.
   */
  releaseQueue: p("cash_advance.view_register").query(() => releaseQueueService()),

  /**
   * §6's project P&L — quoted margin against actual, and the gap between them.
   *
   * On `pnl.view`, which is narrower than the rest of finance: this shows labour cost, and labour
   * cost over hours is close enough to somebody's pay that it cannot be an ordinary report.
   */
  projectPnl: p("pnl.view")
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => projectPnlService(input.projectId)),

  /**
   * §6's cost rates — read on `pnl.view`, written on `cost_rate.manage`.
   *
   * Reading is deliberately the wider permission: a project manager looking at a P&L caveat needs to
   * see whether a rate exists in order to understand the figure, and the number itself is already
   * behind `pnl.view`. Setting one is a payroll decision and is not theirs.
   */
  costRates: p("pnl.view").query(() => costRatesService()),

  /** How many approved days across the company currently cannot be priced. */
  uncostedDays: p("pnl.view").query(() => uncostedDaysService()),

  setCostRate: p("cost_rate.manage")
    .input(
      z.object({
        userId: z.string(),
        effectiveFrom: z.coerce.date(),
        hourlyCost: z.number().min(0),
        overtimeMultiplier: z.number().min(1).optional(),
        travelMultiplier: z.number().min(1).optional(),
        standbyMultiplier: z.number().min(1).optional(),
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => setCostRateService(actorMeta(ctx), input)),

  /**
   * §6's direct expenses.
   *
   * Submitting is on `expense.submit`, which operations holds — the person who arranged the crane
   * knows what it was for. Deciding is on `expense.approve`, and the service additionally refuses to
   * let anybody approve their own.
   */
  expenses: p("expense.submit")
    .input(z.object({ status: z.string().optional() }).optional())
    .query(({ input }) => expensesService(input ?? {})),

  chargeableProjects: p("expense.submit").query(() => chargeableProjectsService()),

  submitExpense: p("expense.submit")
    .input(
      z.object({
        category: z.enum(EXPENSE_CATEGORIES as unknown as [string, ...string[]]),
        vendorName: z.string().max(200).nullish(),
        expenseDate: z.coerce.date(),
        amount: z.number().positive(),
        vatAmount: z.number().nullish(),
        description: z.string().min(3).max(2000),
        projectId: z.string().nullish(),
        salesOrderId: z.string().nullish(),
        ticketId: z.string().nullish(),
        paymentMethod: z.string().max(60).nullish(),
        receiptFileIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      submitExpenseService(actorMeta(ctx), {
        ...input,
        category: input.category as Parameters<typeof submitExpenseService>[1]["category"],
      }),
    ),

  decideExpense: p("expense.approve")
    .input(
      z.object({ id: z.string(), approve: z.boolean(), reason: z.string().max(1000).nullish() }),
    )
    .mutation(({ ctx, input }) => decideExpenseService(actorMeta(ctx), input)),

  /**
   * §3.2 — the customer's 2307 arrived, so the withheld tax becomes creditable and the statement
   * closes. The company chose this reading on 2026-08-20: neither cash nor credit until the form
   * is in hand.
   */
  recordForm2307: p("payment.record")
    .input(
      z.object({
        paymentId: z.string(),
        fileId: z.string().nullish(),
        receivedAt: z.coerce.date().optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordForm2307Service(actorMeta(ctx), input)),

  /** §3's statements, drafts included — the list the billing clerk works from. */
  statements: p("billing_statement.create")
    .input(z.object({ status: z.string().optional(), accountId: z.string().optional() }).optional())
    .query(({ input }) => statementsService(input ?? {})),

  /** §3.3's PDC register: cheques received and not yet cleared. */
  pendingCheques: p("payment.record").query(() => pendingChequesService()),

  /** §7's payables list, aged, with the disputed ones counted. */
  payables: p("payables.manage")
    .input(z.object({ openOnly: z.boolean().optional() }).optional())
    .query(({ input }) => payablesService(input ?? {})),

  /**
   * Record a supplier's bill, and match it against the order and what was received.
   *
   * The match runs here rather than on demand, and its findings are stored: a dispute is a fact
   * about a moment, and re-deriving it later against an amended order would change what somebody is
   * telephoning the supplier about.
   */
  /** Who could bill us, and for which orders — the form's own list, not module 03's register. */
  billableSuppliers: p("payables.manage").query(() => billableSuppliersService()),

  recordSupplierInvoice: p("payables.manage")
    .input(
      z.object({
        supplierId: z.string(),
        supplierPOId: z.string().nullish(),
        supplierRef: z.string().min(1).max(100),
        invoiceDate: z.coerce.date(),
        dueDate: z.coerce.date().nullish(),
        amount: z.number().positive(),
        vatAmount: z.number().nullish(),
        currency: z.string().max(3).optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => recordSupplierInvoiceService(actorMeta(ctx), input)),

  /** Clear a bill for payment. A disputed one needs a written reason. */
  approveSupplierInvoice: p("payables.manage")
    .input(z.object({ id: z.string(), overrideReason: z.string().max(2000).nullish() }))
    .mutation(({ ctx, input }) => approveSupplierInvoiceService(actorMeta(ctx), input)),

  /**
   * Build the file and say whether this period has been exported before.
   *
   * A query, not a mutation: looking must not count as exporting, or the answer to "was this period
   * already done" becomes yes because you just asked.
   */
  previewExport: p("accounting.export")
    .input(
      z.object({
        dataset: z.enum(EXPORT_DATASETS),
        preset: z.enum(EXPORT_PRESETS),
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
      }),
    )
    .query(({ input }) => previewExportService(input)),

  /** Record that the period was exported. §8: so it is not exported twice unnoticed. */
  recordExport: p("accounting.export")
    .input(
      z.object({
        dataset: z.enum(EXPORT_DATASETS),
        preset: z.enum(EXPORT_PRESETS),
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
        rowCount: z.number().int().nonnegative(),
        contentHash: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => recordExportService(actorMeta(ctx), input)),

  exportHistory: p("accounting.export").query(() => exportHistoryService()),
});
