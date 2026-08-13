import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { LOST_REASONS } from "@/server/core/crm/inquiry-lifecycle";
import { emit } from "@/server/core/events/emit";
import {
  computeCosting,
  discountForTargetTotal,
  fromCentavos,
  MARGIN_FLOOR_PCT,
  type VatMode,
} from "@/server/core/quotation/costing";
import { checkQuotationTransition } from "@/server/core/quotation/quotation-lifecycle";
import { QUOTATION_ENTITY_TYPE, type ActorMeta } from "@/server/core/quotation/quotation-service";

/**
 * Negotiation (specs/02-quotation.md §8).
 *
 * §8 opens by quoting the company: *"if not we leave room for negotiations."* That sentence is the
 * whole reason this exists — AIES quotes expecting to be pushed, so the pushing is part of the
 * process rather than an exception to it, and the record has to hold it.
 *
 * ## Why the log is a table and not four columns
 *
 * §8 asks each round to record "the customer's counter-position, AIES's response, who authorised it,
 * and the resulting revision (if any)". Three rounds of push and counter-push is the ordinary case,
 * and columns can only ever hold the last one. The question a sales meeting actually asks — "how far
 * have we already come down?" — is unanswerable from a final position alone.
 *
 * ## What the what-if calculator is for
 *
 * §8: "enter a target price or target discount and immediately see resulting margin, and whether it
 * breaches the approval threshold. If it does, the UI offers to raise the approval request in place."
 *
 * It computes and returns; it writes nothing. A salesperson on the phone needs to know what a number
 * costs *before* committing to it, and a calculator that silently saved would turn every idle
 * "what about 700k?" into a real change to a live document.
 */

export const NEGOTIATION_OUTCOMES = ["conceded", "held", "walked_away"] as const;

// ---- entering the conversation ---------------------------------------------------------------------

/**
 * §2's `sent → under_negotiation`.
 *
 * A person's move, not the system's: the app cannot see that a customer picked up the phone. Kept
 * separate from logging the first round because the two happen at different moments — the status
 * changes when the customer says "we need to talk about the price", and the round is written up
 * afterwards.
 */
export async function startNegotiationService(actor: ActorMeta, input: { quotationId: string }) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, status: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const check = checkQuotationTransition(quotation.status, "under_negotiation");
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: { status: "under_negotiation" },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "negotiation_started",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary: `${quotation.number} is under negotiation`,
      diff: { status: { from: quotation.status, to: "under_negotiation" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

// ---- the round log ----------------------------------------------------------------------------------

export interface LogRoundInput {
  quotationId: string;
  customerPosition: string;
  aiesResponse: string;
  /** Where the price landed, if it moved. */
  agreedTotal?: string | null;
  /** The revision this round produced, if it produced one. */
  resultingQuotationId?: string | null;
}

/**
 * Writes one round.
 *
 * `authorisedById` is the caller, not a field they choose. §8 wants to know who agreed to a
 * concession, and a name typed into a form is a name somebody can get wrong — or get convenient.
 * The round number is allocated from what is already there rather than supplied, so two people
 * writing up the same call cannot produce two "round 3"s.
 */
export async function logNegotiationRoundService(actor: ActorMeta, input: LogRoundInput) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, status: true, currency: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (quotation.status !== "under_negotiation") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${quotation.number} is ${quotation.status.replace(/_/g, " ")}. Move it to under ` +
        `negotiation first — a round logged against a quotation nobody is negotiating is a note ` +
        `in the wrong place.`,
    });
  }

  const position = input.customerPosition.trim();
  const response = input.aiesResponse.trim();
  if (position.length === 0 || response.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A round needs both what they asked for and what AIES said back.",
    });
  }
  if (input.agreedTotal && !/^\d+(\.\d{1,2})?$/.test(input.agreedTotal.trim())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The agreed total has to be a number." });
  }

  return db.$transaction(async (tx) => {
    const last = await tx.negotiationRound.findFirst({
      where: { quotationId: quotation.id },
      orderBy: { roundNo: "desc" },
      select: { roundNo: true },
    });

    const round = await tx.negotiationRound.create({
      data: {
        quotationId: quotation.id,
        roundNo: (last?.roundNo ?? 0) + 1,
        customerPosition: position,
        aiesResponse: response,
        authorisedById: actor.actorId,
        agreedTotal: input.agreedTotal?.trim() ?? null,
        resultingQuotationId: input.resultingQuotationId ?? null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "negotiation_round",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary:
        `Round ${round.roundNo} on ${quotation.number}: ${position.slice(0, 80)}` +
        (input.agreedTotal ? ` — landed at ${quotation.currency} ${input.agreedTotal}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return round;
  });
}

export async function listNegotiationRoundsService(quotationId: string) {
  const rounds = await db.negotiationRound.findMany({
    where: { quotationId },
    orderBy: { roundNo: "asc" },
  });

  const userIds = [...new Set(rounds.map((r) => r.authorisedById))];
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rounds.map((round) => ({
    ...round,
    agreedTotal: round.agreedTotal?.toString() ?? null,
    authorisedByLabel: nameById.get(round.authorisedById) ?? round.authorisedById,
  }));
}

// ---- §8's what-if -------------------------------------------------------------------------------------

export interface WhatIfResult {
  /** The total the customer would pay. */
  targetTotal: string;
  /** The header discount that reaches it. */
  discountAmount: string;
  discountPct: string;
  marginAmount: string;
  marginPct: string | null;
  /** True when the resulting margin is under §4's floor. */
  belowFloor: boolean;
  marginFloorPct: number;
  /**
   * True when taking this price would need the quotation approved again.
   *
   * §6 requires approval before `sent`, and a concession made after the VP approved a *different*
   * number is exactly the case that rule exists for. So any live quotation whose price moves needs
   * re-approval — not only one that breaches the floor.
   */
  needsReapproval: boolean;
  /** Lines that fall below the floor at this price, for the panel to point at. */
  linesBelowFloor: number[];
}

/**
 * Answers "what if we sold it for X?" without writing anything.
 *
 * Runs through `discountForTargetTotal` and then `computeCosting`, which is the same path a real
 * save takes — §4's arithmetic exists once, and a calculator with its own copy of it would
 * eventually disagree with the document.
 */
export async function whatIfService(input: {
  quotationId: string;
  /** Either a target total or a target discount percentage. */
  targetTotal?: string;
  targetDiscountPct?: string;
}): Promise<WhatIfResult> {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: {
      id: true,
      status: true,
      vatMode: true,
      vatRatePct: true,
      fxBufferPct: true,
      lines: { orderBy: { lineNo: "asc" } },
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (quotation.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "There is nothing to price yet.",
    });
  }

  const costingInput = {
    lines: quotation.lines.map((line) => ({
      quantity: line.quantity.toString(),
      // Cost is already landed on the stored line, so it is re-fed at a rate of 1 with no buffer —
      // the same rule the line service follows when it preserves cost.
      unitCost: line.unitCost.toString(),
      costFxRate: "1",
      markupPct: line.markupPct?.toString() ?? null,
      unitPrice: line.unitPrice.toString(),
      lineDiscountPct: line.lineDiscountPct?.toString() ?? null,
      isOptional: line.isOptional,
    })),
    vatMode: quotation.vatMode as VatMode,
    vatRatePct: quotation.vatRatePct.toString(),
    fxBufferPct: "0",
    marginFloorPct: MARGIN_FLOOR_PCT,
  };

  const atListPrice = computeCosting({ ...costingInput, headerDiscount: "0" });

  // A percentage is turned into a target total rather than handled separately, so both inputs reach
  // the same arithmetic and cannot drift apart.
  const target =
    input.targetTotal ??
    fromCentavos(
      Math.round(
        Number(fromCentavos(atListPrice.total)) *
          (1 - Number(input.targetDiscountPct ?? "0") / 100) *
          100,
      ),
    );

  const { discountAmount, result } = discountForTargetTotal(costingInput, target);

  const subtotal = atListPrice.subtotal;
  const discountPct = subtotal > 0 ? ((discountAmount / subtotal) * 100).toFixed(2) : "0.00";

  return {
    targetTotal: fromCentavos(result.total),
    discountAmount: fromCentavos(discountAmount),
    discountPct,
    marginAmount: fromCentavos(result.marginAmount),
    marginPct: result.marginPct === null ? null : result.marginPct.toFixed(2),
    belowFloor: result.marginPct !== null && result.marginPct < MARGIN_FLOOR_PCT,
    marginFloorPct: MARGIN_FLOOR_PCT,
    // Any live quotation whose price moves has to go back through §6 — see the field's own comment.
    needsReapproval:
      discountAmount > 0 && ["approved", "sent", "under_negotiation"].includes(quotation.status),
    // Derived the same way the costing sheet derives it: an optional line nobody is being asked to
    // buy is not below anything.
    linesBelowFloor: result.lines
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(
        ({ line }) =>
          !line.isOptional && line.marginPct !== null && line.marginPct < MARGIN_FLOOR_PCT,
      )
      .map(({ lineNo }) => lineNo),
  };
}

// ---- the customer says no ------------------------------------------------------------------------------

/**
 * §8's "loss-reason picklist feeding win/loss analytics", and its optional competitor field.
 *
 * The picklist is **module 01's** `LOST_REASONS`, not a second list. A loss recorded against a
 * quotation and one recorded against an inquiry answer the same question, and two vocabularies for
 * it would mean neither report could be trusted — which is the exact failure §3 of module 01 says
 * enforced loss reasons exist to prevent.
 */
export async function rejectQuotationService(
  actor: ActorMeta,
  input: {
    quotationId: string;
    lostReason: string;
    competitor?: string | null;
    notes?: string | null;
  },
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, status: true, inquiryId: true, accountId: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const check = checkQuotationTransition(quotation.status, "rejected");
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
  }

  if (!LOST_REASONS.includes(input.lostReason as (typeof LOST_REASONS)[number])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${input.lostReason}" is not one of the loss reasons.`,
    });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        status: "rejected",
        decisionAt: new Date(),
        lostReason: input.lostReason,
        competitor: input.competitor?.trim() || null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "rejected_by_customer",
      entityType: QUOTATION_ENTITY_TYPE,
      entityId: quotation.id,
      summary:
        `${quotation.number} was declined — ${input.lostReason.replace(/_/g, " ")}` +
        (input.competitor ? ` (to ${input.competitor})` : "") +
        (input.notes ? `. ${input.notes}` : ""),
      diff: { status: { from: quotation.status, to: "rejected" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    // §10. Module 01 does not consume this yet — an inquiry is `lost` only when every revision is,
    // and working out "every" belongs to the session that builds win/loss reporting.
    await emit(
      tx,
      "quotation.rejected",
      {
        quotationId: quotation.id,
        number: quotation.number,
        inquiryId: quotation.inquiryId,
        accountId: quotation.accountId,
        lostReason: input.lostReason,
        competitor: input.competitor ?? null,
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return updated;
  });
}
