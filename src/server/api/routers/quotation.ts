import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import { VAT_MODES } from "@/server/core/quotation/costing";
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
        currency: z.string().optional(),
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
        currency: z.string().optional(),
        fxRate: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateQuotationHeaderService(actorMeta(ctx), input)),

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
