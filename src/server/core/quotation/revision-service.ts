import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { isRevisable, REVISION_REASONS } from "@/server/core/quotation/quotation-lifecycle";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import { resolveScopeChangeOnRevision } from "./scope-change-service";
import { diffRevisions, type DiffSide } from "@/server/core/quotation/revision-diff";
import type { ActorMeta } from "@/server/core/quotation/quotation-service";

/**
 * Revisions (specs/02-quotation.md §5).
 *
 * "A `sent` quotation is **immutable**. Changing it creates revision *n+1* in `draft`, cloned from
 * *n*, sharing the base number." That is ISO 9001 clause 8.2.4 evidence for changes to requirements,
 * which is why the reason is mandatory and comes from a picklist rather than a free-text box nobody
 * can report on.
 */

/**
 * Creates revision n+1 as a draft clone.
 *
 * Two decisions worth stating:
 *
 * **The prior revision is not superseded here.** §5 says it becomes `superseded` "at the moment the
 * new one is sent" — so a half-written revision cannot retire a quotation the customer is still
 * holding. Session 3's send flow does that transition.
 *
 * **The chain has one root.** R0 keeps `parentQuotationId` null and every later revision points at
 * it, rather than each pointing at its predecessor. A linked list would make "show me every
 * revision of this quote" a recursive walk, and §12 asks for the chain to keep one root.
 */
export async function reviseQuotationService(
  actor: ActorMeta,
  input: { quotationId: string; revisionReason: string; revisionNote?: string | null },
) {
  if (!REVISION_REASONS.includes(input.revisionReason as (typeof REVISION_REASONS)[number])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `"${input.revisionReason}" is not a revision reason. ` +
        `§5 requires one from the picklist — it is the ISO 8.2.4 record of why the quote changed.`,
    });
  }

  const source = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (!isRevisable(source.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${source.number} is ${source.status.replace(/_/g, " ")} and cannot be revised. ` +
        `Only a quotation the customer has already seen can be.`,
    });
  }

  const rootId = source.parentQuotationId ?? source.id;

  return db.$transaction(async (tx) => {
    // The highest revision across the whole chain, not just this row's — revising R1 while R2
    // exists must still produce R3, or two revisions would collide on the unique [number, revision].
    const latest = await tx.quotation.aggregate({
      where: { OR: [{ id: rootId }, { parentQuotationId: rootId }], deletedAt: null },
      _max: { revision: true },
    });
    const nextRevision = (latest._max.revision ?? source.revision) + 1;

    const revision = await tx.quotation.create({
      data: {
        number: source.number,
        revision: nextRevision,
        parentQuotationId: rootId,
        quoteType: source.quoteType,
        inquiryId: source.inquiryId,
        accountId: source.accountId,
        siteId: source.siteId,
        contactId: source.contactId,
        title: source.title,
        scopeOfWork: source.scopeOfWork,
        exclusions: source.exclusions,
        assumptions: source.assumptions,
        status: "draft",
        currency: source.currency,
        fxRate: source.fxRate,
        fxBufferPct: source.fxBufferPct,
        validUntil: source.validUntil,
        deliveryTermIncoterm: source.deliveryTermIncoterm,
        deliveryLeadTime: source.deliveryLeadTime,
        paymentTermsId: source.paymentTermsId,
        warrantyTerms: source.warrantyTerms,
        subtotal: source.subtotal,
        discountAmount: source.discountAmount,
        vatMode: source.vatMode,
        vatRatePct: source.vatRatePct,
        vatAmount: source.vatAmount,
        total: source.total,
        totalCost: source.totalCost,
        marginAmount: source.marginAmount,
        marginPct: source.marginPct,
        // The person revising owns the new draft; approval starts again from scratch (§6).
        preparedById: actor.actorId,
        revisionReason: input.revisionReason,
        revisionNote: input.revisionNote ?? null,
      },
    });

    if (source.lines.length > 0) {
      await tx.quotationLine.createMany({
        data: source.lines.map((line) => ({
          quotationId: revision.id,
          lineNo: line.lineNo,
          groupLabel: line.groupLabel,
          itemType: line.itemType,
          productId: line.productId,
          description: line.description,
          longDescription: line.longDescription,
          manufacturer: line.manufacturer,
          modelNumber: line.modelNumber,
          partNumber: line.partNumber,
          quantity: line.quantity,
          unit: line.unit,
          unitCost: line.unitCost,
          costCurrency: line.costCurrency,
          costFxRate: line.costFxRate,
          markupPct: line.markupPct,
          unitPrice: line.unitPrice,
          lineDiscountPct: line.lineDiscountPct,
          lineTotal: line.lineTotal,
          lineCost: line.lineCost,
          lineMargin: line.lineMargin,
          supplierQuoteLineId: line.supplierQuoteLineId,
          leadTimeDays: line.leadTimeDays,
          isOptional: line.isOptional,
          notes: line.notes,
        })),
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "revised",
      entityType: "Quotation",
      // Against the *source*, so the trail of the quotation the customer holds records that it was
      // revised. The new draft gets its own create row.
      entityId: source.id,
      summary:
        `Created ${quotationDisplayNumber(revision.number, revision.revision)} from ` +
        `${quotationDisplayNumber(source.number, source.revision)} — ${input.revisionReason}` +
        (input.revisionNote ? `: ${input.revisionNote}` : ""),
      diff: { revision: { from: source.revision, to: nextRevision } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    /**
     * A site inspection's scope-change mark is answered by the revision itself.
     *
     * specs/04-operations-projects.md §6.1 asks the platform to prompt a revision; raising one **is**
     * the action the prompt was asking for, so it clears the mark here rather than leaving somebody
     * to dismiss it afterwards. A second click to acknowledge a thing you have just done is how
     * people learn to dismiss without reading. docs/DECISIONS.md #59.
     *
     * The new revision does not inherit the mark — it is the response to it, not another instance.
     */
    await resolveScopeChangeOnRevision(tx, source.id, actor.actorId);

    await emit(
      tx,
      "quotation.revised",
      {
        quotationId: revision.id,
        supersedesId: source.id,
        number: revision.number,
        revision: nextRevision,
        reason: input.revisionReason,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return {
      quotationId: revision.id,
      revision: nextRevision,
      displayNumber: quotationDisplayNumber(revision.number, nextRevision),
    };
  });
}

/** Every revision of one quotation, oldest first. */
export async function listRevisionsService(quotationId: string) {
  const anchor = await db.quotation.findFirst({
    where: { id: quotationId, deletedAt: null },
    select: { id: true, parentQuotationId: true },
  });
  if (!anchor) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  const rootId = anchor.parentQuotationId ?? anchor.id;

  const rows = await db.quotation.findMany({
    where: { OR: [{ id: rootId }, { parentQuotationId: rootId }], deletedAt: null },
    orderBy: { revision: "asc" },
    select: {
      id: true,
      number: true,
      revision: true,
      status: true,
      total: true,
      revisionReason: true,
      revisionNote: true,
      sentAt: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    total: row.total.toString(),
    displayNumber: quotationDisplayNumber(row.number, row.revision),
  }));
}

/** §5's diff view, assembled from two stored revisions. */
export async function diffRevisionsService(input: { fromId: string; toId: string }) {
  const [from, to] = await Promise.all([
    db.quotation.findFirst({
      where: { id: input.fromId, deletedAt: null },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    }),
    db.quotation.findFirst({
      where: { id: input.toId, deletedAt: null },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    }),
  ]);
  if (!from || !to) {
    throw new TRPCError({ code: "NOT_FOUND", message: "One of those revisions no longer exists." });
  }

  const side = (q: NonNullable<typeof from>): DiffSide => ({
    label: quotationDisplayNumber(q.number, q.revision),
    lines: q.lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      lineTotal: line.lineTotal.toString(),
      isOptional: line.isOptional,
    })),
    terms: {
      validUntil: q.validUntil.toISOString().slice(0, 10),
      deliveryLeadTime: q.deliveryLeadTime,
      paymentTermsId: q.paymentTermsId,
      warrantyTerms: q.warrantyTerms,
      exclusions: q.exclusions,
      assumptions: q.assumptions,
      total: q.total.toString(),
    },
  });

  return diffRevisions(side(from), side(to));
}
