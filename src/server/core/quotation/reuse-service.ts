import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { applyCustomerName, DEFAULT_TERMS_AND_CONDITIONS } from "@/server/core/quotation/terms";
import {
  QUOTE_NUMBER_DOCUMENT_TYPES,
  type QuoteType,
} from "@/server/core/quotation/quotation-number";
import {
  DEFAULT_VALIDITY_DAYS,
  QUOTATION_ENTITY_TYPE,
  type ActorMeta,
} from "@/server/core/quotation/quotation-service";

/**
 * Reuse (specs/02-quotation.md §9).
 *
 * §9's stated purpose is that the system should get easier to use the longer it is used — "the
 * catalogue thus builds itself from real work rather than requiring a data-entry project up front".
 * Everything here follows from that: nothing asks anybody to populate anything in advance.
 *
 * ## Duplicating is not revising
 *
 * They look similar and are opposites. A **revision** shares the base number, supersedes what came
 * before, and is ISO 8.2.4 evidence that requirements changed (§5). A **duplicate** is a new
 * quotation that happens to start from an old one — new number, no chain, possibly a different
 * customer entirely. Conflating them would put a second customer's quotation into the first one's
 * revision history.
 *
 * ## Why a duplicate does not silently refresh costs
 *
 * §9 asks for "a refresh-costs prompt showing which lines have stale supplier pricing", not an
 * automatic update. The old cost is what the last job was actually costed at; replacing it without
 * asking would rewrite the basis of a quotation somebody is about to send, and the person doing the
 * duplicating is the only one who knows whether the supplier's newer price applies to this scope.
 */

/** §9's "`lastCostAt` older than N days". Ninety days is a quarter — one price-list cycle. */
export const STALE_COST_DAYS = 90;

const DAY_MS = 86_400_000;

// ---- duplicating ------------------------------------------------------------------------------------

export interface DuplicateQuotationInput {
  sourceQuotationId: string;
  /** Defaults to the source's account. §9: "to the same or a different account." */
  accountId?: string | null;
  title?: string | null;
  quoteType?: QuoteType;
}

export async function duplicateQuotationService(actor: ActorMeta, input: DuplicateQuotationInput) {
  const source = await db.quotation.findFirst({
    where: { id: input.sourceQuotationId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const accountId = input.accountId ?? source.accountId;
  const account = await db.customerAccount.findFirst({
    where: { id: accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That customer no longer exists." });
  }

  const quoteType = (input.quoteType ?? source.quoteType) as QuoteType;
  const number = await allocateNumber(QUOTE_NUMBER_DOCUMENT_TYPES[quoteType]);

  const created = await db.$transaction(async (tx) => {
    const quotation = await tx.quotation.create({
      data: {
        number,
        revision: 0,
        // No `parentQuotationId`: this is a new quotation, not a revision of the old one. See the
        // file header — putting it in the source's chain would file one customer's document in
        // another's history.
        quoteType,
        // Deliberately not carried over. The source's inquiry is a different customer conversation,
        // and §10's `inquiry.quoting_started` is what links a quotation to an inquiry.
        inquiryId: null,
        accountId: account.id,
        // Site and contact belong to the source's account; carrying them to a different customer
        // would attach the wrong plant.
        siteId: accountId === source.accountId ? source.siteId : null,
        contactId: accountId === source.accountId ? source.contactId : null,
        title: input.title?.trim() || source.title,
        scopeOfWork: source.scopeOfWork,
        exclusions: source.exclusions,
        assumptions: source.assumptions,
        status: "draft",
        currency: source.currency,
        fxRate: source.fxRate,
        fxBufferPct: source.fxBufferPct,
        // A fresh clock. Copying the old date would produce a quotation that is already expired.
        validUntil: new Date(Date.now() + DEFAULT_VALIDITY_DAYS * DAY_MS),
        deliveryTermIncoterm: source.deliveryTermIncoterm,
        deliveryLeadTime: source.deliveryLeadTime,
        paymentTermsId: source.paymentTermsId,
        paymentTermsText: source.paymentTermsText,
        warrantyTerms: source.warrantyTerms,
        // Terms are re-seeded for the *new* customer rather than copied: clause 1 names the client,
        // and a duplicate to a different company that still names the old one is a contract with
        // somebody else's name in it.
        termsAndConditions: applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, account.name),
        subtotal: source.subtotal,
        discountAmount: source.discountAmount,
        vatMode: source.vatMode,
        vatRatePct: source.vatRatePct,
        vatAmount: source.vatAmount,
        total: source.total,
        totalCost: source.totalCost,
        marginAmount: source.marginAmount,
        marginPct: source.marginPct,
        preparedById: actor.actorId,
      },
    });

    if (source.lines.length > 0) {
      await tx.quotationLine.createMany({
        data: source.lines.map((line) => ({
          quotationId: quotation.id,
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
          fxBufferPct: line.fxBufferPct,
          freightCostPct: line.freightCostPct,
          dutiesTaxesPct: line.dutiesTaxesPct,
          localDeliveryCost: line.localDeliveryCost,
          markupPct: line.markupPct,
          unitPrice: line.unitPrice,
          lineDiscountPct: line.lineDiscountPct,
          lineTotal: line.lineTotal,
          lineCost: line.lineCost,
          lineMargin: line.lineMargin,
          // **Not** carried over. The link answers "where did this cost come from?", and the answer
          // for a new quotation is "from an old one" until somebody re-asks the supplier.
          supplierQuoteLineId: null,
          leadTimeDays: line.leadTimeDays,
          isOptional: line.isOptional,
          notes: line.notes,
        })),
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "duplicated",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: `Created ${number} by duplicating ${source.number} for ${account.name}`,
      diff: { duplicatedFrom: { from: null, to: source.number } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "quotation.created",
      {
        quotationId: quotation.id,
        number: quotation.number,
        accountId: account.id,
        duplicatedFromId: source.id,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return quotation;
  });

  return created;
}

// ---- §9's stale-cost prompt ---------------------------------------------------------------------------

export interface StaleCostLine {
  lineNo: number;
  description: string;
  manufacturer: string | null;
  modelNumber: string | null;
  /** What this quotation is currently costed at. */
  currentUnitCost: string;
  /** The catalogue's last seen cost, when there is a matching product. */
  catalogueCost: string | null;
  catalogueCostCurrency: string | null;
  lastCostAt: Date | null;
  daysSinceCost: number | null;
  /** True when the catalogue has a newer cost that differs from this line's. */
  hasNewerCost: boolean;
  /** True when nothing has re-costed this in `STALE_COST_DAYS`. */
  isStale: boolean;
}

/**
 * §9: "a refresh-costs prompt showing which lines have stale supplier pricing".
 *
 * Reports; changes nothing. Staleness is measured against the `Product` catalogue's `lastCostAt`,
 * which is the only record of when anybody last saw a real price for a thing — a line's own cost has
 * no date of its own, because it was copied from wherever it came from.
 *
 * A line with no catalogue entry is reported as stale with a null date rather than quietly omitted:
 * "nobody has ever costed this from a supplier" is a stronger warning than "this is three months
 * old", and silence would read as approval.
 */
export async function staleCostReportService(quotationId: string): Promise<StaleCostLine[]> {
  const lines = await db.quotationLine.findMany({
    where: { quotationId },
    orderBy: { lineNo: "asc" },
  });
  if (lines.length === 0) return [];

  // Matched on manufacturer + model, which is the pair the catalogue is indexed on and the pair a
  // person actually re-quotes against. A description match would find the same pump written three
  // ways and none of them each other.
  const keys = lines
    .filter((line) => line.manufacturer && line.modelNumber)
    .map((line) => ({ manufacturer: line.manufacturer!, modelNumber: line.modelNumber! }));

  const products =
    keys.length > 0
      ? await db.product.findMany({
          where: { OR: keys, isActive: true },
          select: {
            manufacturer: true,
            modelNumber: true,
            lastCost: true,
            lastCostCurrency: true,
            lastCostAt: true,
          },
        })
      : [];

  const key = (m: string | null, mo: string | null) => `${m ?? ""}|${mo ?? ""}`;
  const byKey = new Map(products.map((p) => [key(p.manufacturer, p.modelNumber), p]));
  const now = Date.now();

  return lines.map((line) => {
    const product = byKey.get(key(line.manufacturer, line.modelNumber));
    const lastCostAt = product?.lastCostAt ?? null;
    const daysSinceCost =
      lastCostAt === null ? null : Math.floor((now - lastCostAt.getTime()) / DAY_MS);
    const catalogueCost = product?.lastCost?.toString() ?? null;

    return {
      lineNo: line.lineNo,
      description: line.description,
      manufacturer: line.manufacturer,
      modelNumber: line.modelNumber,
      currentUnitCost: line.unitCost.toString(),
      catalogueCost,
      catalogueCostCurrency: product?.lastCostCurrency ?? null,
      lastCostAt,
      daysSinceCost,
      hasNewerCost: catalogueCost !== null && catalogueCost !== line.unitCost.toString(),
      isStale: daysSinceCost === null || daysSinceCost > STALE_COST_DAYS,
    };
  });
}

// ---- §9's self-building catalogue -----------------------------------------------------------------------

export interface CatalogueCandidate {
  manufacturer: string;
  modelNumber: string;
  description: string;
  unit: string;
  unitCost: string;
  costCurrency: string;
}

/**
 * §9: "when a quotation line uses a manufacturer + model not in `Product`, offer to create it."
 *
 * **Offer**, not create. A catalogue that silently absorbed every typo would be worse than no
 * catalogue at all — it is meant to be the list of things AIES actually sells, and its value is that
 * somebody looked at each entry once.
 */
export async function catalogueCandidatesService(
  quotationId: string,
): Promise<CatalogueCandidate[]> {
  const lines = await db.quotationLine.findMany({
    where: { quotationId },
    orderBy: { lineNo: "asc" },
  });

  const named = lines.filter((line) => line.manufacturer && line.modelNumber);
  if (named.length === 0) return [];

  const existing = await db.product.findMany({
    where: {
      OR: named.map((line) => ({
        manufacturer: line.manufacturer!,
        modelNumber: line.modelNumber!,
      })),
    },
    select: { manufacturer: true, modelNumber: true },
  });
  const known = new Set(existing.map((p) => `${p.manufacturer}|${p.modelNumber ?? ""}`));

  const candidates = new Map<string, CatalogueCandidate>();
  for (const line of named) {
    const k = `${line.manufacturer!}|${line.modelNumber!}`;
    // Deduplicated within the quotation too: the same meter on two lines is one catalogue entry.
    if (known.has(k) || candidates.has(k)) continue;
    candidates.set(k, {
      manufacturer: line.manufacturer!,
      modelNumber: line.modelNumber!,
      description: line.description,
      unit: line.unit,
      unitCost: line.unitCost.toString(),
      costCurrency: line.costCurrency,
    });
  }

  return [...candidates.values()];
}

/**
 * Adds one candidate to the catalogue, stamping the cost that was seen.
 *
 * `lastCostAt` is set here because this is the moment a real price for a real thing entered the
 * system — and it is what §9's staleness prompt measures against later. A catalogue entry with no
 * date would be permanently "never costed", which is true but useless.
 */
export async function addProductFromLineService(
  actor: ActorMeta,
  input: CatalogueCandidate & { category?: string | null; defaultMarkupPct?: string | null },
) {
  const manufacturer = input.manufacturer.trim();
  const modelNumber = input.modelNumber.trim();
  if (manufacturer.length === 0 || modelNumber.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A catalogue entry needs a manufacturer and a model number.",
    });
  }

  const existing = await db.product.findFirst({ where: { manufacturer, modelNumber } });
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${manufacturer} ${modelNumber} is already in the catalogue.`,
    });
  }

  const product = await db.product.create({
    data: {
      name: input.description.slice(0, 120),
      description: input.description,
      manufacturer,
      modelNumber,
      category: input.category?.trim() || null,
      unit: input.unit,
      lastCost: Number(input.unitCost) > 0 ? input.unitCost : null,
      lastCostCurrency: Number(input.unitCost) > 0 ? input.costCurrency : null,
      lastCostAt: Number(input.unitCost) > 0 ? new Date() : null,
      defaultMarkupPct: input.defaultMarkupPct ?? null,
    },
  });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: "Product",
      entityId: product.id,
      summary: `Added ${manufacturer} ${modelNumber} to the catalogue from a quotation line`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return product;
}

// ---- §9's quote templates ------------------------------------------------------------------------

/**
 * §9: "Quote templates for repeat scopes (annual PM contract, standard calibration package)."
 *
 * A template is the *shape* of a quotation with the customer removed: the scope narrative, the
 * commercial terms and the lines. Those are the slow part of writing a quotation and the part that
 * barely changes between two annual PM contracts — the customer, the dates and the numbering are the
 * fast part, and they are exactly what a template does not carry.
 *
 * Captured **from a real quotation** rather than authored in a separate editor. §9's whole theme is
 * that the system should accrete from real work; a template screen nobody fills in is a template
 * screen nobody uses.
 */
export async function saveQuotationAsTemplateService(
  actor: ActorMeta,
  input: { quotationId: string; name: string; description?: string | null },
) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A template needs a name — it is what somebody picks it by later.",
    });
  }

  const source = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (source.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A template with no lines saves nobody any work.",
    });
  }

  const existing = await db.quoteTemplate.findUnique({ where: { name } });
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `There is already a template called "${name}".`,
    });
  }

  const template = await db.quoteTemplate.create({
    data: {
      name,
      description: input.description?.trim() || null,
      quoteType: source.quoteType,
      currency: source.currency,
      scopeOfWork: source.scopeOfWork,
      exclusions: source.exclusions,
      assumptions: source.assumptions,
      deliveryTermIncoterm: source.deliveryTermIncoterm,
      deliveryLeadTime: source.deliveryLeadTime,
      paymentTermsText: source.paymentTermsText,
      warrantyTerms: source.warrantyTerms,
      vatMode: source.vatMode,
      vatRatePct: source.vatRatePct,
      fxBufferPct: source.fxBufferPct,
      createdById: actor.actorId,
      lines: {
        create: source.lines.map((line) => ({
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
          // Raw cost and its rate, the same way `QuotationLine` holds them (docs/DECISIONS.md #32).
          // A template's costs go stale by definition; §9's refresh-costs prompt is what catches
          // that on the quotation the template produces.
          unitCost: line.unitCost,
          costCurrency: line.costCurrency,
          costFxRate: line.costFxRate,
          markupPct: line.markupPct,
          lineDiscountPct: line.lineDiscountPct,
          leadTimeDays: line.leadTimeDays,
          isOptional: line.isOptional,
          notes: line.notes,
        })),
      },
    },
    include: { lines: true },
  });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "template_saved",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: source.id,
      summary: `Saved ${source.number} as the template "${name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return template;
}

export async function listQuoteTemplatesService() {
  const templates = await db.quoteTemplate.findMany({
    where: { isActive: true },
    include: { lines: { orderBy: { lineNo: "asc" } } },
    orderBy: { name: "asc" },
  });

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    quoteType: template.quoteType,
    currency: template.currency,
    lineCount: template.lines.length,
    scopeOfWork: template.scopeOfWork,
  }));
}

/**
 * Raises a real quotation from a template.
 *
 * The template supplies the shape; the caller supplies the customer, which is the one thing a
 * template cannot know. Numbering, validity and status come from the same places they always do, so
 * a quotation started this way is indistinguishable from one typed by hand — which is the point.
 */
export async function createQuotationFromTemplateService(
  actor: ActorMeta,
  input: {
    templateId: string;
    accountId: string;
    title?: string | null;
    inquiryId?: string | null;
  },
) {
  const template = await db.quoteTemplate.findFirst({
    where: { id: input.templateId, isActive: true },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!template) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That template no longer exists." });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That customer no longer exists." });
  }

  const quoteType = template.quoteType as QuoteType;
  const number = await allocateNumber(QUOTE_NUMBER_DOCUMENT_TYPES[quoteType]);

  return db.$transaction(async (tx) => {
    const quotation = await tx.quotation.create({
      data: {
        number,
        revision: 0,
        quoteType,
        inquiryId: input.inquiryId ?? null,
        accountId: account.id,
        title: input.title?.trim() || template.name,
        scopeOfWork: template.scopeOfWork,
        exclusions: template.exclusions,
        assumptions: template.assumptions,
        status: "draft",
        currency: template.currency,
        fxBufferPct: template.fxBufferPct,
        validUntil: new Date(Date.now() + DEFAULT_VALIDITY_DAYS * DAY_MS),
        deliveryTermIncoterm: template.deliveryTermIncoterm,
        deliveryLeadTime: template.deliveryLeadTime,
        paymentTermsText: template.paymentTermsText,
        warrantyTerms: template.warrantyTerms,
        vatMode: template.vatMode,
        vatRatePct: template.vatRatePct,
        // Seeded for *this* customer, like every other quotation: clause 1 names the client, and a
        // template cannot know who that is.
        termsAndConditions: applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, account.name),
        preparedById: actor.actorId,
      },
    });

    if (template.lines.length > 0) {
      await tx.quotationLine.createMany({
        data: template.lines.map((line) => ({
          quotationId: quotation.id,
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
          lineDiscountPct: line.lineDiscountPct,
          leadTimeDays: line.leadTimeDays,
          isOptional: line.isOptional,
          notes: line.notes,
        })),
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: `Created ${number} for ${account.name} from the template "${template.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "quotation.created",
      {
        quotationId: quotation.id,
        number: quotation.number,
        accountId: account.id,
        fromTemplateId: template.id,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return quotation;
  });
}

/** Deactivated, never deleted: a template that produced quotations is part of their history. */
export async function deactivateQuoteTemplateService(
  actor: ActorMeta,
  input: { templateId: string },
) {
  const template = await db.quoteTemplate.findUnique({ where: { id: input.templateId } });
  if (!template) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That template no longer exists." });
  }

  const updated = await db.quoteTemplate.update({
    where: { id: template.id },
    data: { isActive: false },
  });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "template_deactivated",
      entityType: "QuoteTemplate",
      entityId: template.id,
      summary: `Retired the template "${template.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return updated;
}
