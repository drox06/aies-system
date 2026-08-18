import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { stripFieldsUnlessPermitted } from "@/server/core/rbac/field-gating";
import { applyCustomerName, DEFAULT_TERMS_AND_CONDITIONS } from "@/server/core/quotation/terms";
import {
  QUOTE_NUMBER_DOCUMENT_TYPES,
  quotationDisplayNumber,
  type QuoteType,
} from "@/server/core/quotation/quotation-number";
import { checkQuotationTransition } from "@/server/core/quotation/quotation-lifecycle";
import { QUOTATION_ARCHIVE_PERMISSION } from "@/server/core/quotation/archive-rules";

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
  // A cost-side field: it moves landed cost, so somebody who cannot see cost must not see or set it.
  "fxBufferPct",
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
  /** PHP, USD or EUR — the router validates against QUOTE_CURRENCIES. */
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
        // Copied onto the record at creation, with the customer name filled in. A quotation is a
        // contract: the clauses it carries must be the ones that were on it, not whichever set the
        // company is using by the time somebody reprints it.
        termsAndConditions: applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, account.name),
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

export interface ListQuotationsParams {
  search?: string;
  status?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
  /**
   * Show the archived ones instead of the live ones (see archive-rules.ts).
   *
   * Three states, not two: `false`/absent is the working list, `true` is the archive on its own,
   * and there is deliberately no "both". A combined list would put a document somebody is quoting
   * this morning next to one closed out two years ago and give the user no way to tell them apart
   * — which is the problem archiving exists to solve.
   *
   * Ignored without `quotation.view_archive`, and ignored silently: a caller who asks for what
   * they cannot see gets the working list, not an error that confirms an archive exists.
   */
  archived?: boolean;
}

/** Columns a client may sort by. An allow-list, because the key arrives from the query string. */
const SORTABLE = new Set(["number", "title", "status", "total", "validUntil", "createdAt"]);

export async function listQuotationsService(
  user: { id: string; permissions: ReadonlySet<string> },
  params: ListQuotationsParams = {},
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const search = params.search?.trim();

  const showArchive =
    params.archived === true && user.permissions.has(QUOTATION_ARCHIVE_PERMISSION);

  const where = {
    deletedAt: null,
    // The default is the working list for everybody, including the two people who can see the
    // archive. Nobody opens Quotations to look at last year's closed business.
    archivedAt: showArchive ? { not: null } : null,
    ...quotationScopeWhere(user),
    ...(params.status ? { status: params.status } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(search
      ? {
          OR: [
            // Numbers are what people search for, and they quote the *display* form at each other —
            // `contains` rather than equals so AIESLQ260001REV02 finds AIESLQ260001's chain.
            { number: { contains: search, mode: "insensitive" as const } },
            { title: { contains: search, mode: "insensitive" as const } },
            { account: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const sortKey = params.sortKey && SORTABLE.has(params.sortKey) ? params.sortKey : "createdAt";
  const sortDir = params.sortDir === "asc" ? "asc" : "desc";

  const [rows, total] = await Promise.all([
    db.quotation.findMany({
      where,
      orderBy: [{ [sortKey]: sortDir }, { revision: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        revision: true,
        quoteType: true,
        title: true,
        status: true,
        currency: true,
        total: true,
        totalCost: true,
        marginAmount: true,
        marginPct: true,
        validUntil: true,
        createdAt: true,
        preparedById: true,
        account: { select: { id: true, code: true, name: true } },
      },
    }),
    db.quotation.count({ where }),
  ]);

  const canSeeCost = user.permissions.has("finance.view_cost");

  return {
    rows: rows.map((row) => {
      const base = {
        ...row,
        displayNumber: quotationDisplayNumber(row.number, row.revision),
        total: row.total.toString(),
        totalCost: row.totalCost.toString(),
        marginAmount: row.marginAmount.toString(),
        marginPct: row.marginPct.toString(),
      };
      // Same gate as the detail read. A list is a serialised response too, and it is the easier one
      // to forget — §12 tests the payload, not the page.
      return stripFieldsUnlessPermitted(base, [...QUOTATION_COST_FIELDS], canSeeCost);
    }),
    total,
  };
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
      fxBufferPct: line.fxBufferPct?.toString() ?? null,
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

/**
 * The customer ordered against this quotation, so it is no longer a live offer.
 *
 * Called only from module 02's `customer_po.received` subscriber — §10: "`customer_po.received`
 * (module 03 → sets `accepted`)". §2 makes `accepted` system-only for exactly this reason: it is a
 * fact about the customer's paperwork, not a judgement anybody makes in this screen.
 *
 * The practical consequence is what makes it worth doing now rather than in module 03's session:
 * left `sent`, §7's nightly sweep would expire a quotation the customer has already ordered against
 * and notify the owner that a won deal had lapsed.
 *
 * Non-throwing on a quotation that has moved on. A PO can arrive against a revision that was
 * superseded, or after somebody recorded the outcome by hand; the PO is recorded either way, and
 * throwing here would dead-letter a job whose real work is done. Same reasoning as module 01's
 * `quotation.sent` subscriber.
 */
export async function acceptQuotationOnCustomerPo(quotationId: string): Promise<void> {
  const quotation = await db.quotation.findFirst({
    where: { id: quotationId, deletedAt: null },
    select: { id: true, number: true, revision: true, status: true },
  });
  if (!quotation) return;

  const check = checkQuotationTransition(quotation.status, "accepted", { bySystem: true });
  if (!check.ok) {
    console.warn(
      `[quotation] ${quotation.number} is ${quotation.status}; not marking accepted on customer PO ` +
        `(${check.reason})`,
    );
    return;
  }

  await db.$transaction(async (tx) => {
    const { count } = await tx.quotation.updateMany({
      // Guarded on the status it was read with, so a decision made between the read and the write
      // is not overwritten.
      where: { id: quotation.id, status: quotation.status },
      data: { status: "accepted", decisionAt: new Date() },
    });
    if (count === 0) return;

    await writeAuditLog(tx, {
      // No actor: the customer's PO caused this, not a person in this app. The person who recorded
      // the PO is named on the audit row against the inquiry.
      actorId: null,
      actorLabel: "System (customer PO received)",
      action: "accepted",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: `${quotationDisplayNumber(quotation.number, quotation.revision)} accepted — the customer's purchase order arrived`,
      diff: { status: { from: quotation.status, to: "accepted" } },
    });

    await emit(
      tx,
      "quotation.accepted",
      { quotationId: quotation.id, number: quotation.number, revision: quotation.revision },
      {},
    );
  });
}

/**
 * Removes a quotation from the screens, without removing it from the record.
 *
 * **Soft, always.** `deletedAt` is set and every read already filters on it; the row, its lines, its
 * audit trail and its number all stay. Spec.md §5 says numbers are "never reused" — a hard delete
 * would free `AIESLQ260012` to be handed out again, and two different documents would have carried
 * the same number.
 *
 * **A reason is required**, because the question asked six months later is never "was this deleted"
 * but "why". The reason goes in the audit summary, which is the one place that survives.
 *
 * **Refused when a customer PO points at it.** That PO is a real document from a real customer
 * referencing this quotation by number; deleting the thing it answers would leave module 03 holding
 * an order against nothing. Cancel it instead — that is what `cancelled` is for.
 */
export async function deleteQuotationService(
  actor: ActorMeta,
  input: { quotationId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why. The question asked later is never whether it was deleted but why.",
    });
  }

  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, revision: true, status: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const poCount = await db.customerPO.count({
    where: { quotationId: quotation.id, deletedAt: null },
  });
  if (poCount > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} has a customer purchase order recorded against it. Deleting it would ` +
        `leave that order answering nothing — cancel the quotation instead.`,
    });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary:
        `Deleted ${quotationDisplayNumber(quotation.number, quotation.revision)} ` +
        `(was ${quotation.status.replace(/_/g, " ")}) — ${reason}`,
      diff: { deletedAt: { from: null, to: updated.deletedAt?.toISOString() ?? null } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    // Taken out of Ctrl+K too, or it stays findable and opens a page that refuses to load.
    await tx.searchIndex.deleteMany({
      where: { entityType: QUOTATION_ENTITY_TYPE, entityId: quotation.id },
    });

    return { id: updated.id, number: quotation.number };
  });
}
