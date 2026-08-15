import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import { QUOTATION_ENTITY_TYPE } from "@/server/core/quotation/quotation-service";
import {
  registerCustomerPoCheck,
  transitionInquiryService,
} from "@/server/core/crm/inquiry-service";

/**
 * Recording the customer's purchase order (specs/03-order-procurement.md §1-2).
 *
 * §1 calls PO receipt "the pivot point… where the deal stops being a sales artifact and becomes an
 * obligation", and the company asked for exactly that as a pipeline column: a card leaves "Sent"
 * when their PO arrives, and it may not leave without one.
 *
 * ## The gate is the point
 *
 * §2 says "scanned PO is mandatory" and the company said the same thing in their own words. So the
 * document is not an attachment to a status change — it is the *evidence for* the status change, and
 * this service is the only way the inquiry reaches `po_received`. Dragging a card there without one
 * is refused, which is the same shape as §7's "confirm sent needs a prior download": a column that
 * asserts a fact about the outside world has to have something behind it.
 *
 * ## Deliberately not done here
 *
 * No sales order, no ticket generation, no downpayment request — module 03's §1 fans out into four
 * workstreams and all of them are its own session's work. What this does is record the fact and
 * emit `customer_po.received`, which is the event those workstreams will hang off.
 */

export const CUSTOMER_PO_ENTITY_TYPE = "CustomerPO";

/**
 * A PO is commercial paperwork, not a public document.
 *
 * `customer_po.view` is the same permission the record page is gated on, so the file and the row it
 * belongs to are visible to exactly the same people. Without a checker registered here, module 00's
 * default would restrict the file to whoever uploaded it — which would lock finance out of a
 * document they need.
 */
registerFileAccessChecker(CUSTOMER_PO_ENTITY_TYPE, (user) =>
  user.permissions.has("customer_po.view"),
);

/**
 * Teaches §3's state machine how to answer "does this inquiry have a PO?".
 *
 * At module scope, so importing this service is what arms the gate — the same side-effect-on-import
 * pattern as the file-access checker above and as `principal-access.ts`.
 */
registerCustomerPoCheck((inquiryId) => hasCustomerPo(inquiryId));

export interface RecordCustomerPoInput {
  /**
   * The inquiry whose card is moving, when there is one.
   *
   * **Optional**, because a quotation does not always have an inquiry behind it. §9's duplicate
   * produces one with none, and a quotation raised directly from the Quotations screen has none
   * either — and both can still receive a customer PO. Requiring an inquiry here made those
   * quotations unable to record one at all: the pipeline is an inquiry board, so they had no card to
   * drag, and the PO form lived only on the card.
   */
  inquiryId?: string | null;
  /** The quotation the PO answers. One of this or `inquiryId` is required. */
  quotationId?: string | null;
  poNumber: string;
  poDate: Date;
  amount: string;
  currency?: string;
  /** A `FileObject.id` from `POST /api/files`, uploaded against this entity type. */
  fileId: string;
}

/**
 * Records the PO and moves the inquiry to `po_received`.
 *
 * The order matters: the PO row is written first, inside the same transaction as the audit row and
 * the event, and the inquiry transition happens after it. If the transition fails — someone
 * disqualified the inquiry a second earlier — the PO is still recorded, which is correct: the
 * customer's document arrived whatever the board says, and losing it would be the worse outcome.
 */
export async function recordCustomerPoService(actor: ActorMeta, input: RecordCustomerPoInput) {
  if (!input.inquiryId && !input.quotationId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A purchase order has to be against an inquiry or a quotation.",
    });
  }

  // The quotation is the better anchor when there is one: `CustomerPO.quotationId` is what §2 calls
  // for, and the inquiry is only how the pipeline finds it.
  const quotation = input.quotationId
    ? await db.quotation.findFirst({
        where: { id: input.quotationId, deletedAt: null },
        select: { id: true, number: true, status: true, accountId: true, inquiryId: true },
      })
    : null;
  if (input.quotationId && !quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (quotation && !["sent", "under_negotiation", "accepted"].includes(quotation.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} is ${quotation.status.replace(/_/g, " ")}. A customer's purchase ` +
        `order answers a quotation they have been sent.`,
    });
  }

  const inquiryId = input.inquiryId ?? quotation?.inquiryId ?? null;
  const inquiry = inquiryId
    ? await db.inquiry.findFirst({
        where: { id: inquiryId, deletedAt: null },
        select: { id: true, number: true, status: true, accountId: true, ownerId: true },
      })
    : null;
  if (inquiryId && !inquiry) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
  }

  const accountId = inquiry?.accountId ?? quotation?.accountId ?? null;
  if (!accountId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${inquiry?.number ?? quotation?.number ?? "That record"} is not linked to a customer ` +
        `account, so there is nobody for the PO to be from. Link the account first.`,
    });
  }

  // Only checked when the pipeline is actually involved. A quotation with no inquiry has no card,
  // and refusing its PO because a card is in the wrong column would be refusing on behalf of a
  // thing that does not exist.
  if (inquiry && inquiry.status !== "quoted") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        inquiry.status === "po_received"
          ? `${inquiry.number} already has a purchase order recorded.`
          : `${inquiry.number} is ${inquiry.status.replace(/_/g, " ")}. A purchase order is ` +
            `recorded against an inquiry whose quotation has been sent.`,
    });
  }

  const poNumber = input.poNumber.trim();
  if (poNumber.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The customer's PO number is what everything downstream is filed under.",
    });
  }

  // §2: "scanned PO is mandatory". Checked against the stored file rather than trusted from the
  // request, so a client cannot record a PO with an id that points at nothing — or at somebody
  // else's document.
  const file = await db.fileObject.findFirst({
    where: { id: input.fileId, deletedAt: null },
    select: { id: true, entityType: true, entityId: true, filename: true },
  });
  if (!file) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That upload is no longer there. Attach the scanned PO again.",
    });
  }
  // Uploaded against whichever record the person was looking at — the inquiry from the board, the
  // quotation from its own page. Both are checked, so an id from somewhere else still fails.
  const allowedOwners = [inquiry?.id, quotation?.id].filter(Boolean) as string[];
  if (file.entityType !== CUSTOMER_PO_ENTITY_TYPE || !allowedOwners.includes(file.entityId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That file was not uploaded as this record's purchase order.",
    });
  }

  const amount = input.amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The PO amount has to be a plain number, as printed on the customer's document.",
    });
  }

  const po = await db.$transaction(async (tx) => {
    const created = await tx.customerPO.create({
      data: {
        accountId,
        quotationId: quotation?.id ?? null,
        inquiryId: inquiry?.id ?? null,
        poNumber,
        poDate: input.poDate,
        amount,
        currency: input.currency ?? "PHP",
        fileId: file.id,
        receivedById: actor.actorId,
        status: "received",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "customer_po_received",
      // Filed against whichever record the person is looking at, so it lands in that record's
      // activity feed. The PO's own id is in the diff for anything that needs to find the row.
      entityType: inquiry ? "Inquiry" : QUOTATION_ENTITY_TYPE,
      entityId: inquiry?.id ?? quotation!.id,
      summary: `Recorded customer PO ${poNumber} (${created.currency} ${amount}) — ${file.filename}`,
      diff: { customerPoId: { from: null, to: created.id } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    // specs/02-quotation.md §10 names this as an event module 02 consumes to set a quotation
    // `accepted`. Nothing emitted it before, so that subscription could not exist.
    await emit(
      tx,
      "customer_po.received",
      {
        customerPoId: created.id,
        poNumber,
        accountId: created.accountId,
        quotationId: created.quotationId,
        inquiryId: created.inquiryId,
        amount,
        currency: created.currency,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return created;
  });

  // Outside the transaction, and deliberately: see the doc comment. The PO is the fact worth
  // keeping; the board position is a consequence of it.
  //
  // Only when there is a card to move. A quotation with no inquiry has no pipeline position, and
  // that is not a reason to refuse its PO.
  if (inquiry) {
    await transitionInquiryService(actor, {
      inquiryId: inquiry.id,
      to: "po_received",
      // Not `bySystem`. A person recorded this, their name is on the audit row, and the gate is
      // satisfied by the row that person just created.
    });
  }

  return {
    customerPoId: po.id,
    poNumber: po.poNumber,
    inquiryMoved: inquiry !== null,
    status: inquiry ? ("po_received" as const) : ("recorded" as const),
  };
}

/** The POs on an inquiry, newest first — for the record page and the transition gate. */
export function listCustomerPosForInquiry(inquiryId: string) {
  return db.customerPO.findMany({
    where: { inquiryId, deletedAt: null },
    orderBy: { receivedAt: "desc" },
  });
}

/**
 * Whether §3's `quoted → po_received` gate is satisfied.
 *
 * A count, not a fetch: the gate asks one question, and the transition service should not have to
 * hold a PO in memory to answer it.
 */
export async function hasCustomerPo(inquiryId: string): Promise<boolean> {
  const count = await db.customerPO.count({
    where: { inquiryId, deletedAt: null, status: { not: "cancelled" } },
  });
  return count > 0;
}

/** The POs recorded against a quotation — for its own record page. */
export function listCustomerPosForQuotation(quotationId: string) {
  return db.customerPO.findMany({
    where: { quotationId, deletedAt: null },
    orderBy: { receivedAt: "desc" },
  });
}
