import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import { isEditable } from "@/server/core/quotation/quotation-lifecycle";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import type { ActorMeta } from "@/server/core/quotation/quotation-service";

/**
 * The supplier RFQ sub-flow (specs/02-quotation.md §3).
 *
 * §3 opens with the reason it exists: *"Sales team will coordinate with principal supplier for items
 * to be quoted."* — "Make that coordination a first-class record instead of an email nobody can
 * find."
 *
 * ## The app does not send the email, and that is confirmed rather than deferred
 *
 * §3.2: "**Confirmed: this is emailed manually by a person — the Admin Manager (PD) handles supplier
 * price inquiries.** The system produces the document and the draft text, and records that the RFQ
 * was sent; it does not send automatically."
 *
 * So the shape is the same one §7's issuance already uses, for the same honest reason: the app
 * produces a document, a person sends it, and a person asserts that they did. `markRfqSent` is that
 * assertion, and it is what starts the response clock — not `createSupplierRfq`, because a draft
 * sitting unsent is nobody's fault but the sender's.
 *
 * ## Who the supplier is
 *
 * Module 03 owns `Supplier` and does not exist. Module 01's `PrincipalProspect` at stage `appointed`
 * is the interim source — the same deferral `SupplierQuoteRequest.supplierId` was written for, and
 * it becomes a foreign key when module 03 lands. An RFQ can only be raised against an appointed
 * principal, which is the correct rule anyway: §5c's whole point is that a principal is not a
 * supplier until the distributor agreement is signed.
 */

export const RFQ_OVERDUE_NOTIFICATION_TYPE = "supplier_rfq.overdue";

registerNotificationType({
  key: RFQ_OVERDUE_NOTIFICATION_TYPE,
  label: "A supplier price request is overdue",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10). This one wants email
  // when a provider exists: the person who needs to chase a supplier is doing it from their inbox.
  defaultChannels: { inApp: true, email: false, digest: false },
});

export const RFQ_ENTITY_TYPE = "SupplierQuoteRequest";

/**
 * A supplier's quote is a cost document.
 *
 * Gated on `supplier_rfq.manage` — the people §3 puts in charge of supplier pricing — rather than on
 * `finance.view_cost`, which is about *quotation* margin. PD holds the former and not the latter and
 * must be able to open the file they attached; the president and VP hold both. Without a checker
 * registered here module 00's default would restrict the file to whoever uploaded it, which would
 * lock out the very people who need to check what was quoted.
 */
registerFileAccessChecker(RFQ_ENTITY_TYPE, (user) => user.permissions.has("supplier_rfq.manage"));
export const RFQ_DOCUMENT_TYPE = "supplier_rfq";

/** §3.3: sent → responded. `declined` and `expired` are ends the supplier decides. */
export const RFQ_STATUSES = ["draft", "sent", "responded", "declined", "expired"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

// ---- who can be asked -----------------------------------------------------------------------------

export interface RfqSupplierOption {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  productLines: string[];
}

/**
 * The principals an RFQ can be raised against: appointed ones only.
 *
 * Not a bar invented here — §5c makes `appointed` the stage at which a distributor agreement is
 * signed, and asking a prospect you have no agreement with for pricing you intend to quote on is
 * how a company ends up committed to a price it cannot buy at.
 */
export async function listRfqSuppliersService(): Promise<RfqSupplierOption[]> {
  const principals = await db.principalProspect.findMany({
    where: { stage: "appointed", deletedAt: null },
    select: {
      id: true,
      companyName: true,
      contactName: true,
      email: true,
      productLines: true,
    },
    orderBy: { companyName: "asc" },
  });

  return principals.map((p) => ({
    id: p.id,
    name: p.companyName,
    contactName: p.contactName,
    email: p.email,
    productLines: p.productLines,
  }));
}

async function loadSupplier(supplierId: string) {
  const supplier = await db.principalProspect.findFirst({
    where: { id: supplierId, deletedAt: null },
    select: { id: true, companyName: true, stage: true, contactName: true, email: true },
  });
  if (!supplier) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That principal no longer exists." });
  }
  if (supplier.stage !== "appointed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${supplier.companyName} is not an appointed principal yet. Quoting on pricing from a ` +
        `supplier with no signed agreement commits AIES to a price it may not be able to buy at.`,
    });
  }
  return supplier;
}

// ---- raising one ----------------------------------------------------------------------------------

export interface CreateRfqInput {
  quotationId: string;
  supplierId: string;
  /** Quotation line numbers to ask about. Empty means every line. */
  sourceLineNos?: number[];
  /** §3.3's response clock. */
  dueBy?: Date | null;
  /** Anything to say beyond the line list — tolerances, a site constraint, a deadline. */
  notes?: string | null;
}

/**
 * Copies the chosen quotation lines into a draft RFQ.
 *
 * A **copy**, not a reference. The supplier is being asked about the item as it stood when the
 * question was put, and the quotation will keep moving underneath. Storing only ids would make an
 * RFQ printed next week disagree with the one the supplier actually answered.
 */
export async function createSupplierRfqService(actor: ActorMeta, input: CreateRfqInput) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: {
      id: true,
      number: true,
      status: true,
      inquiryId: true,
      title: true,
      lines: {
        orderBy: { lineNo: "asc" },
        select: {
          lineNo: true,
          description: true,
          manufacturer: true,
          modelNumber: true,
          quantity: true,
          unit: true,
        },
      },
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const supplier = await loadSupplier(input.supplierId);

  const wanted = new Set(input.sourceLineNos ?? []);
  const chosen =
    wanted.size > 0 ? quotation.lines.filter((l) => wanted.has(l.lineNo)) : quotation.lines;
  if (chosen.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        quotation.lines.length === 0
          ? `${quotation.number} has no lines yet, so there is nothing to ask about.`
          : "None of those line numbers are on this quotation.",
    });
  }

  const number = await allocateNumber(RFQ_DOCUMENT_TYPE);

  const rfq = await db.$transaction(async (tx) => {
    const created = await tx.supplierQuoteRequest.create({
      data: {
        number,
        quotationId: quotation.id,
        inquiryId: quotation.inquiryId,
        supplierId: supplier.id,
        status: "draft",
        dueBy: input.dueBy ?? null,
        // The body a person will paste into an email. Generated once and stored, so what was sent
        // is what the record shows — regenerating it later from a moved quotation would be a
        // different document wearing the same number.
        requestBody: buildRequestBody({
          number,
          quotationNumber: quotation.number,
          title: quotation.title,
          supplierName: supplier.companyName,
          contactName: supplier.contactName,
          dueBy: input.dueBy ?? null,
          notes: input.notes ?? null,
          lines: chosen.map((l) => ({
            description: l.description,
            manufacturer: l.manufacturer,
            modelNumber: l.modelNumber,
            quantity: l.quantity.toString(),
            unit: l.unit,
          })),
        }),
        requestedById: actor.actorId,
        lines: {
          create: chosen.map((line, index) => ({
            lineNo: index + 1,
            sourceLineNo: line.lineNo,
            description: line.description,
            manufacturer: line.manufacturer,
            modelNumber: line.modelNumber,
            quantity: line.quantity,
            unit: line.unit,
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "rfq_raised",
      entityType: "Quotation",
      entityId: quotation.id,
      summary: `Raised ${number} to ${supplier.companyName} for ${chosen.length} line(s)`,
      diff: { rfqId: { from: null, to: created.id } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return rfq;
}

// ---- the send, asserted by a person ---------------------------------------------------------------

/**
 * §3.2's "mark as sent" step, which "starts the response clock".
 *
 * The same two-facts shape as §7's issuance, and for the same reason: the app produced a document
 * and cannot watch it leave. `dueBy` may be set here rather than at creation, because the date a
 * person promises a supplier is one they usually pick as they write the email.
 */
export async function markRfqSentService(
  actor: ActorMeta,
  input: { rfqId: string; sentAt?: Date | null; dueBy?: Date | null },
) {
  const rfq = await db.supplierQuoteRequest.findFirst({
    where: { id: input.rfqId, deletedAt: null },
    select: {
      id: true,
      number: true,
      status: true,
      quotationId: true,
      supplierId: true,
      dueBy: true,
    },
  });
  if (!rfq) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That request no longer exists." });
  }
  if (rfq.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${rfq.number} is already ${rfq.status}.`,
    });
  }

  const sentAt = input.sentAt ?? new Date();
  const dueBy = input.dueBy ?? rfq.dueBy;

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.supplierQuoteRequest.update({
      where: { id: rfq.id },
      data: { status: "sent", sentAt, dueBy },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "rfq_sent",
      entityType: RFQ_ENTITY_TYPE,
      entityId: rfq.id,
      summary:
        `Sent ${rfq.number} to the supplier` +
        (dueBy ? `, response due ${dueBy.toISOString().slice(0, 10)}` : ""),
      diff: { status: { from: "draft", to: "sent" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "supplier_rfq.sent",
      {
        rfqId: rfq.id,
        number: rfq.number,
        quotationId: rfq.quotationId,
        supplierId: rfq.supplierId,
        dueBy: dueBy?.toISOString() ?? null,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return row;
  });

  return updated;
}

// ---- the response ---------------------------------------------------------------------------------

export interface RecordRfqResponseInput {
  rfqId: string;
  lines: {
    lineNo: number;
    unitCost: string;
    currency?: string;
    leadTimeDays?: number | null;
    notes?: string | null;
  }[];
  responseNotes?: string | null;
  currency?: string | null;
  validUntil?: Date | null;
  leadTimeDays?: number | null;
  /** §3.4: the supplier's own quote, attached as evidence of what they actually said. */
  responseFileId?: string | null;
  respondedAt?: Date | null;
}

/**
 * §3.4: "Response captured either by manual entry or by pasting/uploading the supplier's quote."
 *
 * Both, and they are not alternatives — the figures have to be typed for anything downstream to use
 * them, and the supplier's own document is what proves the figures were not invented. The file is
 * optional only because a price sometimes arrives in the body of an email with nothing attached.
 */
export async function recordRfqResponseService(actor: ActorMeta, input: RecordRfqResponseInput) {
  const rfq = await db.supplierQuoteRequest.findFirst({
    where: { id: input.rfqId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!rfq) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That request no longer exists." });
  }
  if (rfq.status === "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${rfq.number} has not been sent yet. A response to a request nobody sent is a request ` +
        `that was sent by some route this system knows nothing about — mark it sent first.`,
    });
  }

  const known = new Set(rfq.lines.map((l) => l.lineNo));
  for (const line of input.lines) {
    if (!known.has(line.lineNo)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${rfq.number} has no line ${line.lineNo}.`,
      });
    }
    if (!/^\d+(\.\d{1,2})?$/.test(line.unitCost.trim())) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Line ${line.lineNo}: a unit cost has to be a plain number.`,
      });
    }
  }

  if (input.responseFileId) {
    const file = await db.fileObject.findFirst({
      where: { id: input.responseFileId, deletedAt: null },
      select: { id: true, entityType: true, entityId: true },
    });
    if (!file || file.entityType !== RFQ_ENTITY_TYPE || file.entityId !== rfq.id) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That file was not uploaded against this request.",
      });
    }
  }

  const respondedAt = input.respondedAt ?? new Date();

  const updated = await db.$transaction(async (tx) => {
    for (const line of input.lines) {
      await tx.supplierQuoteLine.update({
        where: { requestId_lineNo: { requestId: rfq.id, lineNo: line.lineNo } },
        data: {
          unitCost: line.unitCost.trim(),
          currency: line.currency ?? input.currency ?? "PHP",
          leadTimeDays: line.leadTimeDays ?? input.leadTimeDays ?? null,
          notes: line.notes ?? null,
        },
      });
    }

    const row = await tx.supplierQuoteRequest.update({
      where: { id: rfq.id },
      data: {
        status: "responded",
        respondedAt,
        responseNotes: input.responseNotes ?? null,
        currency: input.currency ?? null,
        validUntil: input.validUntil ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        responseFileId: input.responseFileId ?? null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "rfq_responded",
      entityType: RFQ_ENTITY_TYPE,
      entityId: rfq.id,
      summary:
        `Recorded the supplier's response to ${rfq.number}: ${input.lines.length} line(s) priced` +
        (input.responseFileId ? ", with their quote attached" : ""),
      diff: { status: { from: rfq.status, to: "responded" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "supplier_rfq.responded",
      {
        rfqId: rfq.id,
        number: rfq.number,
        quotationId: rfq.quotationId,
        supplierId: rfq.supplierId,
        linesPriced: input.lines.length,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return row;
  });

  return updated;
}

// ---- applying it back ------------------------------------------------------------------------------

/**
 * §3.5: "one action pulls supplier costs into the matching quotation lines, setting `unitCost`,
 * `costCurrency`, `leadTimeDays`, and linking `supplierQuoteLineId`. **The link is what lets anyone
 * later answer 'where did this cost come from?'**"
 *
 * ## Why this passes `canSeeCost: true` when the caller may not hold `finance.view_cost`
 *
 * `saveQuotationLinesService` zeroes cost for a caller who cannot see it — that guard exists so a
 * cost-blind *browser*, which was never sent the figures, cannot post zeros back and silently
 * destroy them. Here the figures do not come from the browser at all: they are read from the
 * `SupplierQuoteLine` rows on the server, and the caller supplies nothing but "apply this RFQ".
 *
 * That distinction matters in practice, because §3 gives this flow to PD (`admin_manager`), who
 * holds `supplier_rfq.manage` and deliberately does **not** hold `finance.view_cost` (Spec.md §4.3).
 * Without this, the person the spec put in charge of supplier pricing would wipe every cost they
 * applied. The read path is untouched: PD still cannot see the resulting margin.
 */
export async function applyRfqToQuotationService(
  actor: ActorMeta,
  input: { rfqId: string; lineNos?: number[]; fxRate?: string | null },
) {
  const rfq = await db.supplierQuoteRequest.findFirst({
    where: { id: input.rfqId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!rfq) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That request no longer exists." });
  }
  if (rfq.status !== "responded") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${rfq.number} has no recorded response yet, so there is no cost to apply.`,
    });
  }
  if (!rfq.quotationId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${rfq.number} was not raised against a quotation.`,
    });
  }

  const quotation = await db.quotation.findFirst({
    where: { id: rfq.quotationId, deletedAt: null },
    select: {
      id: true,
      number: true,
      status: true,
      version: true,
      currency: true,
      fxRate: true,
      fxBufferPct: true,
      lines: { orderBy: { lineNo: "asc" } },
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (!isEditable(quotation.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} is ${quotation.status.replace(/_/g, " ")} and cannot be edited. ` +
        `Create a revision — §5 makes a sent quotation immutable, supplier pricing or not.`,
    });
  }

  const wanted = new Set(input.lineNos ?? []);
  const applicable = rfq.lines.filter(
    (line) =>
      line.sourceLineNo !== null &&
      Number(line.unitCost) > 0 &&
      (wanted.size === 0 || wanted.has(line.lineNo)),
  );
  if (applicable.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Nothing on ${rfq.number} can be applied: a line needs a price and a quotation line to ` +
        `apply it to.`,
    });
  }

  /**
   * Turns a supplier's figure into a cost in the quotation's currency.
   *
   * §4: "Supplier costs are frequently USD or EUR. Store `unitCost` in `costCurrency` **and** the
   * `costFxRate` used at the time of quoting."
   *
   * **This refuses rather than guesses.** An earlier version of this function handed the supplier's
   * raw number to the line service with a rate of 1, so a EUR 1,450 part was stored as a cost of
   * 1,450 *pesos* — roughly a sixty-fifth of the truth. The margin then looked enormous, the floor
   * never tripped, and the quotation went to the VP's queue looking like the best deal of the year.
   * A wrong rate is not better than a missing one, so a missing one stops the operation.
   *
   * The buffer is applied here too, and the result handed over as `costsAreLanded` — see that
   * flag's own comment for why re-feeding a landed cost through the engine is what makes a buffer
   * compound.
   */
  const buffer = Number(quotation.fxBufferPct);
  const landedCost = (raw: string, supplierCurrency: string): string => {
    if (supplierCurrency === quotation.currency) {
      return (Number(raw) * (1 + buffer / 100)).toFixed(2);
    }

    const rate = Number(input.fxRate ?? quotation.fxRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate === 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `${rfq.number} is priced in ${supplierCurrency} and ${quotation.number} is in ` +
          `${quotation.currency}, but no exchange rate has been set. Set the quotation's FX rate ` +
          `first — applying it without one would record the cost as though ` +
          `${supplierCurrency} 1 were ${quotation.currency} 1.`,
      });
    }
    return (Number(raw) * rate * (1 + buffer / 100)).toFixed(2);
  };

  const bySourceLineNo = new Map(applicable.map((line) => [line.sourceLineNo!, line]));
  let applied = 0;

  const lines = quotation.lines.map((line) => {
    const supplied = bySourceLineNo.get(line.lineNo);
    const base = {
      groupLabel: line.groupLabel,
      itemType: line.itemType,
      productId: line.productId,
      description: line.description,
      longDescription: line.longDescription,
      manufacturer: line.manufacturer,
      modelNumber: line.modelNumber,
      partNumber: line.partNumber,
      quantity: line.quantity.toString(),
      unit: line.unit,
      unitCost: line.unitCost.toString(),
      costCurrency: line.costCurrency,
      // The stored rate is carried through unchanged — §4 forbids overwriting a historical one.
      // It is not re-applied: `costsAreLanded` below tells the engine so.
      costFxRate: line.costFxRate.toString(),
      markupPct: line.markupPct?.toString() ?? null,
      unitPrice: line.unitPrice.toString(),
      lineDiscountPct: line.lineDiscountPct?.toString() ?? null,
      supplierQuoteLineId: line.supplierQuoteLineId,
      leadTimeDays: line.leadTimeDays,
      isOptional: line.isOptional,
      notes: line.notes,
    };
    if (!supplied) return base;

    applied += 1;
    return {
      ...base,
      unitCost: landedCost(supplied.unitCost.toString(), supplied.currency),
      // §4: "Store `unitCost` in `costCurrency` **and** the `costFxRate` used at the time of
      // quoting. Never overwrite a historical rate." The rate that was used is recorded on the line
      // even though the stored cost is already converted, so the arithmetic can be checked later.
      costCurrency: supplied.currency,
      costFxRate:
        supplied.currency === quotation.currency
          ? "1"
          : (input.fxRate ?? quotation.fxRate.toString()),
      leadTimeDays: supplied.leadTimeDays ?? base.leadTimeDays,
      // §3.5's link, and the whole reason this is one action rather than retyping.
      supplierQuoteLineId: supplied.id,
    };
  });

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    // See the doc comment: the figures come from the server, not from a browser that was never
    // shown them.
    canSeeCost: true,
    // Both the untouched lines and the newly applied ones are landed by the time they get here, so
    // the engine must not apply FX or the buffer a second time.
    costsAreLanded: true,
    lines,
  });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "rfq_applied",
      entityType: "Quotation",
      entityId: quotation.id,
      summary: `Applied supplier pricing from ${rfq.number} to ${applied} line(s)`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { applied, quotationId: quotation.id };
}

// ---- reading ----------------------------------------------------------------------------------------

export async function listRfqsForQuotationService(quotationId: string) {
  const rows = await db.supplierQuoteRequest.findMany({
    where: { quotationId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
    orderBy: { createdAt: "desc" },
  });

  const supplierIds = [...new Set(rows.map((r) => r.supplierId))];
  const suppliers = await db.principalProspect.findMany({
    where: { id: { in: supplierIds } },
    select: { id: true, companyName: true },
  });
  const nameById = new Map(suppliers.map((s) => [s.id, s.companyName]));

  return rows.map((row) => ({
    ...row,
    supplierName: nameById.get(row.supplierId) ?? row.supplierId,
    lines: row.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
      unitCost: line.unitCost.toString(),
    })),
  }));
}

/**
 * §3.6's comparison matrix: the same source line across every supplier asked.
 *
 * Built here rather than in the browser because "the same line" means *the same `sourceLineNo`*,
 * which is a fact about how the RFQs were raised — not something a component should be re-deriving
 * from descriptions that may have been edited since.
 */
export interface ComparisonRow {
  sourceLineNo: number;
  description: string;
  quantity: string;
  offers: {
    rfqId: string;
    rfqNumber: string;
    supplierId: string;
    supplierName: string;
    rfqLineNo: number;
    supplierQuoteLineId: string;
    unitCost: string;
    currency: string;
    leadTimeDays: number | null;
    validUntil: Date | null;
    /** True when this offer is the cheapest for the line, before lead time is weighed. */
    isCheapest: boolean;
    /** True when this is the offer currently costed onto the quotation line. */
    isApplied: boolean;
  }[];
}

export async function compareRfqsForQuotationService(
  quotationId: string,
): Promise<ComparisonRow[]> {
  const rfqs = await listRfqsForQuotationService(quotationId);
  const responded = rfqs.filter((r) => r.status === "responded");
  if (responded.length === 0) return [];

  const quotationLines = await db.quotationLine.findMany({
    where: { quotationId },
    orderBy: { lineNo: "asc" },
    select: { lineNo: true, description: true, quantity: true, supplierQuoteLineId: true },
  });
  const appliedByLineNo = new Map(
    quotationLines.map((l) => [l.lineNo, l.supplierQuoteLineId] as const),
  );

  const byLine = new Map<number, ComparisonRow>();
  for (const rfq of responded) {
    for (const line of rfq.lines) {
      if (line.sourceLineNo === null || Number(line.unitCost) <= 0) continue;

      const source = quotationLines.find((l) => l.lineNo === line.sourceLineNo);
      const row =
        byLine.get(line.sourceLineNo) ??
        ({
          sourceLineNo: line.sourceLineNo,
          description: source?.description ?? line.description,
          quantity: source?.quantity.toString() ?? line.quantity,
          offers: [],
        } satisfies ComparisonRow);

      row.offers.push({
        rfqId: rfq.id,
        rfqNumber: rfq.number,
        supplierId: rfq.supplierId,
        supplierName: rfq.supplierName,
        rfqLineNo: line.lineNo,
        supplierQuoteLineId: line.id,
        unitCost: line.unitCost,
        currency: line.currency,
        leadTimeDays: line.leadTimeDays,
        validUntil: rfq.validUntil,
        isCheapest: false,
        isApplied: appliedByLineNo.get(line.sourceLineNo) === line.id,
      });
      byLine.set(line.sourceLineNo, row);
    }
  }

  for (const row of byLine.values()) {
    // Cheapest by the raw number, and deliberately not "best": §3.6 asks for a matrix of cost, lead
    // time and validity so a person can weigh them. A cheapest-wins default would quietly make that
    // decision for them, and lead time is often the one that matters.
    //
    // Currencies are not converted here for the same reason — comparing a USD offer against a PHP
    // one needs the quotation's rate, and pretending otherwise would flag the wrong winner.
    const currencies = new Set(row.offers.map((o) => o.currency));
    if (currencies.size === 1) {
      const min = Math.min(...row.offers.map((o) => Number(o.unitCost)));
      for (const offer of row.offers) offer.isCheapest = Number(offer.unitCost) === min;
    }
    row.offers.sort((a, b) => Number(a.unitCost) - Number(b.unitCost));
  }

  return [...byLine.values()].sort((a, b) => a.sourceLineNo - b.sourceLineNo);
}

// ---- §3.3's overdue sweep ---------------------------------------------------------------------------

export interface RfqOverdueSweepResult {
  notified: { rfqId: string; number: string; daysOverdue: number }[];
  scanned: number;
}

const DAY_MS = 86_400_000;

/**
 * §3.3: "Overdue RFQs (past `dueBy`) surface in a dashboard list and notify the owner."
 *
 * Fires on the day the deadline passes and then weekly, rather than daily. A supplier who has not
 * answered in a week will not answer faster for being chased every morning, and a notification that
 * arrives every day is one people filter.
 */
export async function sweepOverdueRfqs(now: Date = new Date()): Promise<RfqOverdueSweepResult> {
  const candidates = await db.supplierQuoteRequest.findMany({
    // The exact query `@@index([status, dueBy])` was created for.
    where: { deletedAt: null, status: "sent", dueBy: { lt: now } },
    select: { id: true, number: true, dueBy: true, requestedById: true, supplierId: true },
  });

  const dayIndex = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  const notified: RfqOverdueSweepResult["notified"] = [];

  for (const rfq of candidates) {
    if (!rfq.dueBy) continue;
    const daysOverdue = dayIndex(now) - dayIndex(rfq.dueBy);
    if (daysOverdue < 0) continue;
    if (daysOverdue !== 0 && daysOverdue % 7 !== 0) continue;

    try {
      await notify({
        recipientId: rfq.requestedById,
        type: RFQ_OVERDUE_NOTIFICATION_TYPE,
        title:
          daysOverdue === 0
            ? `${rfq.number} was due today and the supplier has not answered`
            : `${rfq.number} is ${daysOverdue} days overdue`,
        body:
          `Nothing can be costed on this line until they come back. Chase them, or record the ` +
          `response if it arrived by some other route.`,
        entityType: RFQ_ENTITY_TYPE,
        entityId: rfq.id,
      });
      notified.push({ rfqId: rfq.id, number: rfq.number, daysOverdue });
    } catch (error) {
      console.error("[quotation] failed to notify about an overdue RFQ", rfq.id, error);
    }
  }

  return { notified, scanned: candidates.length };
}

// ---- the document body -------------------------------------------------------------------------------

/**
 * The text PD pastes into an email (§3.2's "copy to clipboard").
 *
 * Plain text on purpose. It is going into a mail client that will reformat anything cleverer, and a
 * supplier's sales desk reads it as an email rather than as a document — the PDF is the document.
 */
export function buildRequestBody(input: {
  number: string;
  quotationNumber: string;
  title: string;
  supplierName: string;
  contactName: string | null;
  dueBy: Date | null;
  notes: string | null;
  lines: {
    description: string;
    manufacturer: string | null;
    modelNumber: string | null;
    quantity: string;
    unit: string;
  }[];
}): string {
  const greeting = input.contactName ? `Dear ${input.contactName},` : `Dear ${input.supplierName},`;
  const items = input.lines
    .map((line, index) => {
      const parts = [line.description];
      if (line.manufacturer) parts.push(line.manufacturer);
      if (line.modelNumber) parts.push(line.modelNumber);
      return `${index + 1}. ${parts.join(" — ")}\n   Quantity: ${line.quantity} ${line.unit}`;
    })
    .join("\n");

  return [
    greeting,
    "",
    `We are preparing a proposal for a customer and would like your best pricing on the following.`,
    `Our reference: ${input.number}.`,
    "",
    items,
    "",
    input.notes ? `${input.notes}\n` : "",
    `For each item please confirm: unit price, currency, lead time from order, and how long the`,
    `quotation stays valid.`,
    input.dueBy
      ? `\nWe would be grateful for your response by ${input.dueBy.toISOString().slice(0, 10)}.`
      : "",
    "",
    "Thank you,",
    "AIES Electromechanical Corporation",
  ]
    .filter((part) => part !== "")
    .join("\n");
}
