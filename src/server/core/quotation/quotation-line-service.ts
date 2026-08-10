import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { computeCosting, fromCentavos, type VatMode } from "@/server/core/quotation/costing";
import { isEditable } from "@/server/core/quotation/quotation-lifecycle";
import type { ActorMeta } from "@/server/core/quotation/quotation-service";

/**
 * Writing a quotation's lines and its recomputed totals (specs/02-quotation.md §4).
 *
 * **This is the only place `subtotal`, `total`, `totalCost`, `marginAmount` and `marginPct` are
 * written.** Every one of them is derived from the lines by `computeCosting`, so a second writer —
 * a "quick edit the total" action, a migration that patches a figure — would put the stored numbers
 * out of step with the lines that justify them, and nothing would notice until a customer added the
 * column up themselves.
 */

export interface QuotationLineInput {
  groupLabel?: string | null;
  itemType?: string;
  productId?: string | null;
  description: string;
  longDescription?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  partNumber?: string | null;
  quantity: string;
  unit?: string;
  unitCost?: string;
  costCurrency?: string;
  costFxRate?: string;
  /** Null means the price was typed directly and the margin is implied (§4). */
  markupPct?: string | null;
  unitPrice?: string | null;
  lineDiscountPct?: string | null;
  supplierQuoteLineId?: string | null;
  leadTimeDays?: number | null;
  isOptional?: boolean;
  notes?: string | null;
}

export interface SaveLinesInput {
  quotationId: string;
  /** The caller's copy of `version`. §12: a stale one must conflict, not overwrite. */
  version: number;
  /**
   * Whether the caller holds `finance.view_cost`.
   *
   * Load-bearing, not informational. `getQuotationService` strips `unitCost`, `markupPct` and
   * `costFxRate` from the lines it sends to anyone without that permission — so a salesperson
   * editing a quotation posts back lines with **no cost in them at all**. Accepting those verbatim
   * would zero the costs and hand the quotation a fictional 100% margin, silently, on a document
   * heading for the VP's approval queue.
   *
   * When false, existing costs are carried over by line number instead. See below.
   */
  canSeeCost: boolean;
  lines: QuotationLineInput[];
  headerDiscount?: string | null;
  vatMode?: VatMode;
  vatRatePct?: string | null;
  fxBufferPct?: string | null;
  marginFloorPct?: number | null;
}

/**
 * Replaces a quotation's lines and stores the recomputed commercial summary.
 *
 * Replace rather than diff: line numbers are positional, a partial update leaves gaps, and the
 * builder sends the whole table anyway. Nothing yet references a `QuotationLine` by id — module 03
 * will, from a sales order, and this becomes a diff on that day.
 */
export async function saveQuotationLinesService(actor: ActorMeta, input: SaveLinesInput) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: {
      id: true,
      number: true,
      status: true,
      version: true,
      vatMode: true,
      vatRatePct: true,
      fxBufferPct: true,
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  // §12: "Sent quotations reject edit attempts at the service layer, not just in the UI."
  if (!isEditable(quotation.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} is ${quotation.status.replace(/_/g, " ")} and cannot be edited. ` +
        `Create a revision instead — a sent quotation is immutable.`,
    });
  }

  const vatMode = (input.vatMode ?? (quotation.vatMode as VatMode)) satisfies VatMode;
  const vatRatePct = input.vatRatePct ?? quotation.vatRatePct.toString();

  /**
   * Cost carried over for a caller who cannot see it.
   *
   * Matched by line number, which is what the builder round-trips unchanged: a salesperson editing
   * descriptions and prices keeps the positions the server sent them. A line they *added* has no
   * predecessor and therefore no cost — which is honest, since nobody has costed it yet, and the
   * margin panel will show the gap to whoever can see it.
   *
   * Reordering is the case this cannot follow, and it is why the builder does not offer it to a
   * caller without cost visibility.
   */
  const preservedByLineNo = new Map<
    number,
    { unitCost: string; markupPct: string | null; costFxRate: string }
  >();
  if (!input.canSeeCost) {
    const existing = await db.quotationLine.findMany({
      where: { quotationId: quotation.id },
      select: { lineNo: true, unitCost: true, markupPct: true, costFxRate: true },
    });
    for (const line of existing) {
      preservedByLineNo.set(line.lineNo, {
        // The stored unitCost is already landed, so it is re-fed with a rate of 1 and no buffer —
        // applying FX a second time would inflate the cost on every save.
        unitCost: line.unitCost.toString(),
        markupPct: line.markupPct?.toString() ?? null,
        costFxRate: "1",
      });
    }
  }

  /** The cost inputs to cost this line with, given who is saving. */
  const costFor = (line: QuotationLineInput, index: number) => {
    if (input.canSeeCost) {
      return {
        unitCost: line.unitCost ?? "0",
        costFxRate: line.costFxRate ?? "1",
        markupPct: line.markupPct ?? null,
      };
    }
    const preserved = preservedByLineNo.get(index + 1);
    return {
      unitCost: preserved?.unitCost ?? "0",
      costFxRate: preserved?.costFxRate ?? "1",
      // The markup is a cost-side field too: deriving a price from a markup the caller cannot see
      // would let them move cost by proxy.
      markupPct: preserved?.markupPct ?? null,
    };
  };

  // The engine decides every figure; this service only stores what it returns.
  const costing = computeCosting({
    lines: input.lines.map((line, index) => ({
      quantity: line.quantity,
      ...costFor(line, index),
      unitPrice: line.unitPrice ?? "0",
      lineDiscountPct: line.lineDiscountPct ?? null,
      isOptional: line.isOptional === true,
    })),
    headerDiscount: input.headerDiscount ?? "0",
    vatMode,
    vatRatePct,
    // Zero when the caller cannot see cost: their preserved figures are already landed, and
    // applying the buffer again would inflate cost a little more on every save.
    fxBufferPct: input.canSeeCost ? (input.fxBufferPct ?? "0") : "0",
    marginFloorPct: input.marginFloorPct ?? null,
  });

  const updated = await db.$transaction(async (tx) => {
    // Optimistic lock. Spec.md §10 names quotations specifically; §12 requires a conflict rather
    // than a silent overwrite. `updateMany` is deliberate — `update` throws on a missing row, which
    // would be indistinguishable from the record having been deleted.
    const { count } = await tx.quotation.updateMany({
      where: { id: quotation.id, version: input.version },
      data: {
        version: { increment: 1 },
        subtotal: fromCentavos(costing.subtotal),
        discountAmount: fromCentavos(costing.discountAmount),
        vatMode,
        vatRatePct,
        vatAmount: fromCentavos(costing.vatAmount),
        total: fromCentavos(costing.total),
        totalCost: fromCentavos(costing.totalCost),
        marginAmount: fromCentavos(costing.marginAmount),
        marginPct: costing.marginPct === null ? "0" : costing.marginPct.toFixed(4),
        fxBufferPct: input.canSeeCost
          ? (input.fxBufferPct ?? "0")
          : quotation.fxBufferPct.toString(),
      },
    });

    if (count === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          `${quotation.number} was changed by someone else while you were editing. ` +
          `Reload to see their version — your changes have not been saved.`,
      });
    }

    await tx.quotationLine.deleteMany({ where: { quotationId: quotation.id } });
    if (input.lines.length > 0) {
      await tx.quotationLine.createMany({
        data: input.lines.map((line, index) => {
          const computed = costing.lines[index]!;
          return {
            quotationId: quotation.id,
            lineNo: index + 1,
            groupLabel: line.groupLabel ?? null,
            itemType: line.itemType ?? "product",
            productId: line.productId ?? null,
            description: line.description,
            longDescription: line.longDescription ?? null,
            manufacturer: line.manufacturer ?? null,
            modelNumber: line.modelNumber ?? null,
            partNumber: line.partNumber ?? null,
            quantity: line.quantity,
            unit: line.unit ?? "pc",
            // The *landed* cost the engine computed, not the raw input: FX and the buffer are
            // applied once, here, so the stored figure is the one the margin was calculated from.
            unitCost: fromCentavos(computed.unitCost),
            costCurrency: line.costCurrency ?? "PHP",
            costFxRate: input.canSeeCost ? (line.costFxRate ?? "1") : "1",
            markupPct: costFor(line, index).markupPct,
            unitPrice: fromCentavos(computed.unitPrice),
            lineDiscountPct: line.lineDiscountPct ?? null,
            lineTotal: fromCentavos(computed.lineTotal),
            lineCost: fromCentavos(computed.lineCost),
            lineMargin: fromCentavos(computed.lineMargin),
            supplierQuoteLineId: line.supplierQuoteLineId ?? null,
            leadTimeDays: line.leadTimeDays ?? null,
            isOptional: line.isOptional === true,
            notes: line.notes ?? null,
          };
        }),
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "Quotation",
      entityId: quotation.id,
      summary:
        `Updated ${quotation.number}: ${input.lines.length} line(s), ` +
        `total ${fromCentavos(costing.total)}`,
      // The figures are in the diff because §1 makes margin the decision this module records, and
      // "what did the total look like before?" is the question a negotiation asks afterwards.
      diff: {
        total: { from: null, to: fromCentavos(costing.total) },
        marginAmount: { from: null, to: fromCentavos(costing.marginAmount) },
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return tx.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
  });

  return {
    version: updated.version,
    linesBelowFloor: costing.linesBelowFloor,
    costing,
  };
}

/**
 * Header fields that do not change the arithmetic — scope narrative, terms, validity.
 *
 * Separate from the line save so typing in the scope box does not rewrite every line, and so the
 * two can carry different permissions later if that ever matters.
 */
export interface UpdateQuotationHeaderInput {
  quotationId: string;
  version: number;
  title?: string;
  scopeOfWork?: string;
  exclusions?: string | null;
  assumptions?: string | null;
  validUntil?: Date | null;
  deliveryTermIncoterm?: string | null;
  deliveryLeadTime?: string | null;
  paymentTermsId?: string | null;
  paymentTermsText?: string | null;
  warrantyTerms?: string | null;
  /** §7's clauses, per quotation. Replaced wholesale — the editor sends the whole list. */
  termsAndConditions?: string[];
  currency?: string;
  fxRate?: string;
}

export async function updateQuotationHeaderService(
  actor: ActorMeta,
  input: UpdateQuotationHeaderInput,
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, status: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (!isEditable(quotation.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${quotation.number} is ${quotation.status.replace(/_/g, " ")} and cannot be edited.`,
    });
  }

  const data: Prisma.QuotationUpdateInput = { version: { increment: 1 } };
  for (const field of [
    "title",
    "scopeOfWork",
    "exclusions",
    "assumptions",
    "validUntil",
    "deliveryTermIncoterm",
    "deliveryLeadTime",
    "paymentTermsId",
    "paymentTermsText",
    "warrantyTerms",
    "termsAndConditions",
    "currency",
    "fxRate",
  ] as const) {
    if (input[field] !== undefined) {
      (data as Record<string, unknown>)[field] = input[field];
    }
  }

  const { count } = await db.quotation.updateMany({
    where: { id: quotation.id, version: input.version },
    data: data as Prisma.QuotationUpdateManyMutationInput,
  });
  if (count === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        `${quotation.number} was changed by someone else while you were editing. ` +
        `Reload to see their version — your changes have not been saved.`,
    });
  }

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "Quotation",
      entityId: quotation.id,
      summary: `Updated ${quotation.number}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { ok: true as const };
}
