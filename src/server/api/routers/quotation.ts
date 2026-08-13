import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import { QUOTE_CURRENCIES, VAT_MODES } from "@/server/core/quotation/costing";
import { QUOTE_TYPES } from "@/server/core/quotation/quotation-number";
import { REVISION_REASONS } from "@/server/core/quotation/quotation-lifecycle";
import {
  createQuotationService,
  getQuotationService,
  listQuotationsService,
  type ActorMeta,
} from "@/server/core/quotation/quotation-service";
import {
  saveQuotationLinesService,
  updateQuotationHeaderService,
} from "@/server/core/quotation/quotation-line-service";
import {
  diffRevisionsService,
  listRevisionsService,
  reviseQuotationService,
} from "@/server/core/quotation/revision-service";
import {
  confirmQuotationSentService,
  recordQuotationDownloadService,
} from "@/server/core/quotation/send-service";
import {
  applyRfqToQuotationService,
  compareRfqsForQuotationService,
  createSupplierRfqService,
  listRfqsForQuotationService,
  listRfqSuppliersService,
  markRfqSentService,
  recordRfqResponseService,
} from "@/server/core/quotation/rfq-service";
import {
  decideQuotationApprovalService,
  getQuotationApprovalStateService,
  listQuotationApprovalQueueService,
  submitQuotationForApprovalService,
} from "@/server/core/quotation/approval-service";

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

/** Shared by save and the builder's preview. Money crosses the wire as strings, never floats. */
const lineInput = z.object({
  groupLabel: z.string().nullish(),
  itemType: z.string().optional(),
  productId: z.string().nullish(),
  description: z.string().min(1),
  longDescription: z.string().nullish(),
  manufacturer: z.string().nullish(),
  modelNumber: z.string().nullish(),
  partNumber: z.string().nullish(),
  quantity: z.string(),
  unit: z.string().optional(),
  unitCost: z.string().optional(),
  costCurrency: z.string().optional(),
  costFxRate: z.string().optional(),
  markupPct: z.string().nullish(),
  unitPrice: z.string().nullish(),
  lineDiscountPct: z.string().nullish(),
  supplierQuoteLineId: z.string().nullish(),
  leadTimeDays: z.number().int().nullish(),
  isOptional: z.boolean().optional(),
  notes: z.string().nullish(),
});

export const quotationRouter = router({
  list: p("quotation.view")
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.string().optional(),
          accountId: z.string().optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(100).optional(),
          sortKey: z.string().nullish(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listQuotationsService(ctx.user, input ?? {})),

  get: p("quotation.view")
    .input(z.object({ quotationId: z.string() }))
    .query(({ ctx, input }) => getQuotationService(ctx.user, input.quotationId)),

  create: p("quotation.create")
    .input(
      z.object({
        accountId: z.string(),
        inquiryId: z.string().nullish(),
        siteId: z.string().nullish(),
        contactId: z.string().nullish(),
        quoteType: z.enum(QUOTE_TYPES).optional(),
        title: z.string().min(1),
        scopeOfWork: z.string().optional(),
        validUntil: z.coerce.date().nullish(),
        currency: z.enum(QUOTE_CURRENCIES).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createQuotationService(actorMeta(ctx), input)),

  /**
   * The one write that recomputes the commercial summary.
   *
   * `version` is required, not optional. §12 wants a conflict rather than a silent overwrite, and
   * an optional version would let a caller opt out of the lock by omitting it.
   */
  saveLines: p("quotation.edit")
    .input(
      z.object({
        quotationId: z.string(),
        version: z.number().int().nonnegative(),
        lines: z.array(lineInput),
        headerDiscount: z.string().nullish(),
        vatMode: z.enum(VAT_MODES).optional(),
        vatRatePct: z.string().nullish(),
        fxBufferPct: z.string().nullish(),
        marginFloorPct: z.number().nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      saveQuotationLinesService(actorMeta(ctx), {
        ...input,
        // Read from the session, never from the request body — a client that could assert its own
        // cost visibility could overwrite costs it was never allowed to see.
        canSeeCost: ctx.user.permissions.has("finance.view_cost"),
      }),
    ),

  updateHeader: p("quotation.edit")
    .input(
      z.object({
        quotationId: z.string(),
        version: z.number().int().nonnegative(),
        title: z.string().min(1).optional(),
        scopeOfWork: z.string().optional(),
        exclusions: z.string().nullish(),
        assumptions: z.string().nullish(),
        validUntil: z.coerce.date().nullish(),
        deliveryTermIncoterm: z.string().nullish(),
        deliveryLeadTime: z.string().nullish(),
        paymentTermsId: z.string().nullish(),
        paymentTermsText: z.string().nullish(),
        warrantyTerms: z.string().nullish(),
        termsAndConditions: z.array(z.string()).optional(),
        currency: z.enum(QUOTE_CURRENCIES).optional(),
        fxRate: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateQuotationHeaderService(actorMeta(ctx), input)),

  // ---- §6 approval ----------------------------------------------------------------------------

  /**
   * Gated on `quotation.edit`, not on `quotation.approve`.
   *
   * Submitting is the preparer's act — they are asking for a decision, not making one. Gating it on
   * the approval permission would mean only the VP could ever put a quotation in front of the VP.
   */
  submitForApproval: p("quotation.edit")
    .input(z.object({ quotationId: z.string() }))
    .mutation(({ ctx, input }) => submitQuotationForApprovalService(actorMeta(ctx), input)),

  /**
   * `ctx.user` is passed whole, from the session.
   *
   * The approvals engine decides eligibility from the caller's roles — including whether this is
   * Spec.md §4.4's fallback — so the identity it judges must be the authenticated one and can never
   * come from the request body.
   */
  decideApproval: p("quotation.approve")
    .input(
      z.object({
        quotationId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => decideQuotationApprovalService(actorMeta(ctx), ctx.user, input)),

  /**
   * §6's first-class queue.
   *
   * `quotation.view` rather than `quotation.approve`: the service returns only what the caller is
   * eligible to see, so a wider gate here shows an empty list rather than someone else's work — and
   * the President's rows appear on their own once the escalation window elapses.
   */
  approvalQueue: p("quotation.view").query(({ ctx }) =>
    listQuotationApprovalQueueService(ctx.user),
  ),

  approvalState: p("quotation.view")
    .input(z.object({ quotationId: z.string() }))
    .query(({ ctx, input }) => getQuotationApprovalStateService(ctx.user, input.quotationId)),

  // ---- §7 issuance ----------------------------------------------------------------------------

  /**
   * Records that the document was produced. Called by the PDF route rather than a button — the
   * fact is "the bytes left the server", and anything else is a guess about intent.
   */
  recordDownload: p("quotation.send")
    .input(
      z.object({
        quotationId: z.string(),
        variant: z.enum(["customer", "internal"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) => recordQuotationDownloadService(actorMeta(ctx), input)),

  /**
   * The human assertion that it reached the customer, since nothing here can watch an external
   * mail client. This is what fires `quotation.sent` and moves the inquiry to `quoted`.
   */
  confirmSent: p("quotation.send")
    .input(
      z.object({
        quotationId: z.string(),
        sentAt: z.coerce.date().nullish(),
        sentToContactIds: z.array(z.string()).optional(),
        note: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => confirmQuotationSentService(actorMeta(ctx), input)),

  // ---- §3 supplier RFQ ------------------------------------------------------------------------

  /** Appointed principals only — §5c makes that the stage at which an agreement exists. */
  rfqSuppliers: p("supplier_rfq.manage").query(() => listRfqSuppliersService()),

  rfqsForQuotation: p("quotation.view")
    .input(z.object({ quotationId: z.string() }))
    .query(({ input }) => listRfqsForQuotationService(input.quotationId)),

  /** §3.6's matrix. Read-gated with the quotation, since it carries supplier cost. */
  rfqComparison: p("finance.view_cost")
    .input(z.object({ quotationId: z.string() }))
    .query(({ input }) => compareRfqsForQuotationService(input.quotationId)),

  createRfq: p("supplier_rfq.manage")
    .input(
      z.object({
        quotationId: z.string(),
        supplierId: z.string(),
        sourceLineNos: z.array(z.number().int().positive()).optional(),
        dueBy: z.coerce.date().nullish(),
        notes: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createSupplierRfqService(actorMeta(ctx), input)),

  /** §3.2's "mark as sent", which starts the response clock. */
  markRfqSent: p("supplier_rfq.manage")
    .input(
      z.object({
        rfqId: z.string(),
        sentAt: z.coerce.date().nullish(),
        dueBy: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => markRfqSentService(actorMeta(ctx), input)),

  recordRfqResponse: p("supplier_rfq.manage")
    .input(
      z.object({
        rfqId: z.string(),
        lines: z.array(
          z.object({
            lineNo: z.number().int().positive(),
            unitCost: z.string().min(1),
            currency: z.string().optional(),
            leadTimeDays: z.number().int().nullish(),
            notes: z.string().nullish(),
          }),
        ),
        responseNotes: z.string().nullish(),
        currency: z.string().nullish(),
        validUntil: z.coerce.date().nullish(),
        leadTimeDays: z.number().int().nullish(),
        responseFileId: z.string().nullish(),
        respondedAt: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => recordRfqResponseService(actorMeta(ctx), input)),

  /**
   * §3.5. Gated on `supplier_rfq.manage`, **not** on `finance.view_cost`.
   *
   * §3 gives this to PD, who by Spec.md §4.3 cannot see quotation cost. The service reads the
   * figures from the stored RFQ rather than from the request body, so applying them does not
   * require the caller to have been shown them — see its doc comment.
   */
  applyRfq: p("supplier_rfq.manage")
    .input(
      z.object({
        rfqId: z.string(),
        lineNos: z.array(z.number().int().positive()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => applyRfqToQuotationService(actorMeta(ctx), input)),

  // ---- §5 revisions --------------------------------------------------------------------------

  revise: p("quotation.revise")
    .input(
      z.object({
        quotationId: z.string(),
        revisionReason: z.enum(REVISION_REASONS),
        revisionNote: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => reviseQuotationService(actorMeta(ctx), input)),

  revisions: p("quotation.view")
    .input(z.object({ quotationId: z.string() }))
    .query(({ input }) => listRevisionsService(input.quotationId)),

  diff: p("quotation.view")
    .input(z.object({ fromId: z.string(), toId: z.string() }))
    .query(({ input }) => diffRevisionsService(input)),
});
