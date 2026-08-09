import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { stripFieldsUnlessPermitted } from "@/server/core/rbac/field-gating";
import {
  QUOTE_NUMBER_DOCUMENT_TYPES,
  quotationDisplayNumber,
  type QuoteType,
} from "@/server/core/quotation/quotation-number";

/**
 * Quotation writes and reads (specs/02-quotation.md).
 *
 * Out of the router for the reason established in module 00 session 3: a router module pulls in
 * Auth.js, which cannot load outside the Next.js runtime.
 */

export const QUOTATION_ENTITY_TYPE = "Quotation";

export interface ActorMeta {
  actorId: string;
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

// ---- cost gating --------------------------------------------------------------------------------

/**
 * The fields Spec.md §4.3 restricts to `president` and `vice_president`.
 *
 * §4.3 is explicit that this is "enforced by stripping the fields in the service layer, not by
 * hiding them in the UI", and §12 tests it by "inspecting the serialised response" — so these names
 * are the single list both the header and the line stripping work from.
 */
export const QUOTATION_COST_FIELDS = ["totalCost", "marginAmount", "marginPct"] as const;
export const QUOTATION_LINE_COST_FIELDS = [
  "unitCost",
  "costCurrency",
  "costFxRate",
  "markupPct",
  "lineCost",
  "lineMargin",
] as const;

/**
 * Removes cost and margin from a quotation on its way out, unless the caller may see them.
 *
 * Applied to the whole object graph, not just the header. A margin panel hidden in the UI while
 * `lines[0].unitCost` still rides along in the JSON is not access control — it is a rendering
 * choice that anyone with the browser's network tab can undo, and §12 tests the payload precisely
 * because that mistake is invisible from the screen.
 *
 * This is also the check module 00's review gate deferred: "a non-privileged role cannot see cost
 * fields in the serialised response" could not be tested there because no cost field existed yet.
 */
export function stripQuotationCosts<
  T extends Record<string, unknown> & { lines?: Record<string, unknown>[] },
>(quotation: T, permissions: ReadonlySet<string>): Record<string, unknown> {
  const canSeeCost = permissions.has("finance.view_cost");
  const header = stripFieldsUnlessPermitted(quotation, [...QUOTATION_COST_FIELDS], canSeeCost);

  if (!Array.isArray(quotation.lines)) return header;

  return {
    ...header,
    lines: quotation.lines.map((line) =>
      stripFieldsUnlessPermitted(line, [...QUOTATION_LINE_COST_FIELDS], canSeeCost),
    ),
  };
}

// ---- creation -----------------------------------------------------------------------------------

export interface CreateQuotationInput {
  accountId: string;
  inquiryId?: string | null;
  siteId?: string | null;
  contactId?: string | null;
  quoteType?: QuoteType;
  title: string;
  scopeOfWork?: string;
  /** §2 requires a validity date. Defaults to 30 days, the usual AIES term. */
  validUntil?: Date | null;
  currency?: string;
}

/** §7's default validity. A quotation with no expiry never becomes `expired`, so it never leaves
 *  the pipeline and never prompts anybody to chase it. */
export const DEFAULT_VALIDITY_DAYS = 30;

export async function createQuotationService(actor: ActorMeta, input: CreateQuotationInput) {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A quotation needs a title." });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That account does not exist." });
  }

  const quoteType: QuoteType = input.quoteType ?? "local";
  // Allocated before the transaction, like every other number in this codebase: allocateNumber
  // takes no transaction client, so a rollback burns one. Spec.md §5 permits gaps.
  const number = await allocateNumber(QUOTE_NUMBER_DOCUMENT_TYPES[quoteType]);

  const validUntil = input.validUntil ?? new Date(Date.now() + DEFAULT_VALIDITY_DAYS * 86_400_000);

  const quotation = await db.$transaction(async (tx) => {
    const created = await tx.quotation.create({
      data: {
        number,
        revision: 0,
        quoteType,
        accountId: account.id,
        inquiryId: input.inquiryId ?? null,
        siteId: input.siteId ?? null,
        contactId: input.contactId ?? null,
        title,
        scopeOfWork: input.scopeOfWork ?? "",
        validUntil,
        currency: input.currency ?? "PHP",
        status: "draft",
        preparedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: created.id,
      summary: `Created quotation ${created.number} for ${account.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "quotation.created",
      {
        quotationId: created.id,
        number: created.number,
        accountId: account.id,
        inquiryId: created.inquiryId,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return created;
  });

  return quotation;
}

/**
 * §10: module 02 consumes `inquiry.quoting_started`. §3 of module 01 says moving to `quoting`
 * "creates a linked Quotation draft (module 02)".
 *
 * Idempotent by design. Module 00's queue guarantees at-least-once delivery, so this can be called
 * twice for one inquiry — and the second call must not issue a second quotation number against the
 * same work. It returns the existing draft instead.
 *
 * The actor is the inquiry's owner rather than a system id: somebody prepares this quotation, and
 * an unowned draft is one nobody chases. Falls back to the event's actor when the inquiry has no
 * owner, which should not happen but is not worth failing the handler over.
 */
export async function createDraftForInquiry(input: {
  inquiryId: string;
  actorId?: string | null;
}): Promise<{ quotationId: string; created: boolean } | null> {
  const inquiry = await db.inquiry.findFirst({
    where: { id: input.inquiryId, deletedAt: null },
    select: {
      id: true,
      number: true,
      subject: true,
      description: true,
      accountId: true,
      siteId: true,
      contactId: true,
      ownerId: true,
      account: { select: { name: true } },
    },
  });
  if (!inquiry) return null;

  // An inquiry can reach `quoting` before anyone has attached it to an account (module 01 §2 makes
  // accountId optional on purpose). There is nothing to quote to yet, so the draft waits.
  if (!inquiry.accountId) return null;

  const existing = await db.quotation.findFirst({
    where: { inquiryId: inquiry.id, deletedAt: null },
    select: { id: true },
    orderBy: { revision: "asc" },
  });
  if (existing) return { quotationId: existing.id, created: false };

  const ownerId = inquiry.ownerId || input.actorId || "system";
  const quotation = await createQuotationService(
    { actorId: ownerId, actorLabel: "System (from inquiry)" },
    {
      accountId: inquiry.accountId,
      inquiryId: inquiry.id,
      siteId: inquiry.siteId,
      contactId: inquiry.contactId,
      title: inquiry.subject,
      // The customer's own words carry across as the starting scope. §1 calls the scope narrative
      // the artefact the customer actually reads, and starting from what they asked for beats
      // starting from an empty box.
      scopeOfWork: inquiry.description ?? "",
    },
  );

  return { quotationId: quotation.id, created: true };
}

// ---- reads --------------------------------------------------------------------------------------

/** §11's record scoping, as a `where` fragment — never a post-filter. */
export function quotationScopeWhere(user: { id: string; permissions: ReadonlySet<string> }) {
  if (user.permissions.has("quotation.view_all")) return {};
  return { preparedById: user.id };
}

export async function getQuotationService(
  user: { id: string; permissions: ReadonlySet<string> },
  quotationId: string,
) {
  const quotation = await db.quotation.findFirst({
    where: { id: quotationId, deletedAt: null, ...quotationScopeWhere(user) },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      account: { select: { id: true, code: true, name: true } },
      inquiry: { select: { id: true, number: true } },
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const serialisable = {
    ...quotation,
    displayNumber: quotationDisplayNumber(quotation.number, quotation.revision),
    // Decimals cross the wire as strings so they never pass through a float.
    subtotal: quotation.subtotal.toString(),
    discountAmount: quotation.discountAmount.toString(),
    vatAmount: quotation.vatAmount.toString(),
    total: quotation.total.toString(),
    totalCost: quotation.totalCost.toString(),
    marginAmount: quotation.marginAmount.toString(),
    marginPct: quotation.marginPct.toString(),
    lines: quotation.lines.map((line) => ({
      ...line,
      quantity: line.quantity.toString(),
      unitCost: line.unitCost.toString(),
      costFxRate: line.costFxRate.toString(),
      markupPct: line.markupPct?.toString() ?? null,
      unitPrice: line.unitPrice.toString(),
      lineDiscountPct: line.lineDiscountPct?.toString() ?? null,
      lineTotal: line.lineTotal.toString(),
      lineCost: line.lineCost.toString(),
      lineMargin: line.lineMargin.toString(),
    })),
  };

  // Stripped last, so nothing downstream can reintroduce a cost field after the gate.
  return stripQuotationCosts(serialisable, user.permissions);
}
