import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  listNegotiationRoundsService,
  logNegotiationRoundService,
  rejectQuotationService,
  startNegotiationService,
  whatIfService,
} from "@/server/core/quotation/negotiation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";

/**
 * specs/02-quotation.md §8's negotiation.
 *
 * §8 quotes the company — *"if not we leave room for negotiations"* — so the record has to hold a
 * sequence, not a final position. The assertions that matter are the ones a sales meeting would ask
 * of it: how far have we already come down, who agreed to it, and what does the next number cost us.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `neg-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM (marketing manager)" };

const accountIds: string[] = [];
const quotationIds: string[] = [];

/** One line at 100,000 cost and 25% markup: 125,000 net, 140,000 with 12% VAT. */
async function makeSentQuotation() {
  const account = await db.customerAccount.create({
    data: { code: `NG-${randomUUID().slice(0, 12)}`, name: `Neg Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Supply of a level transmitter",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      { description: "Level transmitter", quantity: "1", unitCost: "100000", markupPct: "25" },
    ],
  });

  await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

afterAll(async () => {
  await db.negotiationRound.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("opening a negotiation", () => {
  it("moves a sent quotation to under_negotiation", async () => {
    const quotation = await makeSentQuotation();
    const updated = await startNegotiationService(actor, { quotationId: quotation.id });
    expect(updated.status).toBe("under_negotiation");
  }, 60_000);

  it("refuses to open one on a draft", async () => {
    // §2's map has no such edge, and it should not: there is nobody to negotiate with until the
    // customer has the document.
    const account = await db.customerAccount.create({
      data: { code: `ND-${randomUUID().slice(0, 12)}`, name: `Draft Co ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Still a draft",
    });
    quotationIds.push(quotation.id);

    await expect(startNegotiationService(actor, { quotationId: quotation.id })).rejects.toThrow();
  }, 60_000);
});

describe("the round log", () => {
  it("records both positions, who authorised it, and numbers itself", async () => {
    const quotation = await makeSentQuotation();
    await startNegotiationService(actor, { quotationId: quotation.id });

    await logNegotiationRoundService(actor, {
      quotationId: quotation.id,
      customerPosition: "They want 130,000 all-in and will decide Friday.",
      aiesResponse: "Held at 140,000; offered to include commissioning.",
    });
    await logNegotiationRoundService(actor, {
      quotationId: quotation.id,
      customerPosition: "Came back at 135,000, final.",
      aiesResponse: "Agreed, on 100% advance payment.",
      agreedTotal: "135000.00",
    });

    const rounds = await listNegotiationRoundsService(quotation.id);
    expect(rounds.map((r) => r.roundNo)).toEqual([1, 2]);
    // The question a sales meeting actually asks: how far have we come down? Unanswerable from a
    // final position alone, which is why this is a log and not four columns.
    expect(rounds[0]!.agreedTotal).toBeNull();
    expect(rounds[1]!.agreedTotal).toBe("135000");
    expect(rounds[1]!.authorisedById).toBe(OWNER);
  }, 60_000);

  it("will not log a round against a quotation nobody is negotiating", async () => {
    const quotation = await makeSentQuotation();

    await expect(
      logNegotiationRoundService(actor, {
        quotationId: quotation.id,
        customerPosition: "x",
        aiesResponse: "y",
      }),
    ).rejects.toThrow(/Move it to under negotiation first/);
  }, 60_000);

  it("needs both sides of the conversation", async () => {
    const quotation = await makeSentQuotation();
    await startNegotiationService(actor, { quotationId: quotation.id });

    await expect(
      logNegotiationRoundService(actor, {
        quotationId: quotation.id,
        customerPosition: "   ",
        aiesResponse: "We said no.",
      }),
    ).rejects.toThrow(/both what they asked for and what AIES said back/);
  }, 60_000);
});

describe("§8's what-if calculator", () => {
  it("prices a target total and shows what it does to the margin", async () => {
    const quotation = await makeSentQuotation();

    // List price is 140,000 (125,000 + 12% VAT) on a cost of 100,000.
    const result = await whatIfService({ quotationId: quotation.id, targetTotal: "112000" });

    expect(result.targetTotal).toBe("112000.00");
    // 112,000 gross → 100,000 net → a 25,000 discount off the 125,000 subtotal.
    expect(result.discountAmount).toBe("25000.00");
    expect(result.discountPct).toBe("20.00");
    // Which lands the margin at exactly nothing.
    expect(result.marginAmount).toBe("0.00");
    expect(result.belowFloor).toBe(true);
  }, 60_000);

  it("takes a discount percentage and reaches the same arithmetic", async () => {
    // Both inputs go through one path on purpose — two implementations of the same sum eventually
    // disagree, and the one that disagrees with the document is the one somebody quoted from.
    const quotation = await makeSentQuotation();

    const byPct = await whatIfService({ quotationId: quotation.id, targetDiscountPct: "10" });
    const byTotal = await whatIfService({ quotationId: quotation.id, targetTotal: "126000" });

    expect(byPct.targetTotal).toBe(byTotal.targetTotal);
    expect(byPct.marginAmount).toBe(byTotal.marginAmount);
  }, 60_000);

  it("writes nothing", async () => {
    // A calculator that saved would turn every idle "what about 700k?" on a phone call into a real
    // change to a live document.
    const quotation = await makeSentQuotation();
    const before = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

    await whatIfService({ quotationId: quotation.id, targetTotal: "100000" });

    const after = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(after.total.toString()).toBe(before.total.toString());
    expect(after.discountAmount.toString()).toBe(before.discountAmount.toString());
    expect(after.version).toBe(before.version);
  }, 60_000);

  it("says a concession needs re-approval, because §6 approved a different number", async () => {
    const quotation = await makeSentQuotation();
    const result = await whatIfService({ quotationId: quotation.id, targetTotal: "120000" });
    expect(result.needsReapproval).toBe(true);
  }, 60_000);

  it("does not claim a healthy price is below the floor", async () => {
    const quotation = await makeSentQuotation();
    // A 2% trim leaves margin around 23%, comfortably over the 15% floor.
    const result = await whatIfService({ quotationId: quotation.id, targetDiscountPct: "2" });
    expect(result.belowFloor).toBe(false);
    expect(result.linesBelowFloor).toHaveLength(0);
  }, 60_000);
});

describe("when the customer declines", () => {
  it("records the loss with module 01's picklist and the competitor", async () => {
    const quotation = await makeSentQuotation();

    await rejectQuotationService(actor, {
      quotationId: quotation.id,
      lostReason: "price",
      competitor: "Endress+Hauser Philippines",
    });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("rejected");
    expect(stored.lostReason).toBe("price");
    expect(stored.competitor).toBe("Endress+Hauser Philippines");
    // Distinct from `rejectionReason`, which is why the VP sent it back — a report on internal
    // rework and one on lost business must not read from the same column.
    expect(stored.rejectionReason).toBeNull();

    const event = await db.eventOutbox.findFirst({
      where: { event: "quotation.rejected", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(event?.payload)).toContain("price");
  }, 60_000);

  it("refuses a reason that is not on the picklist", async () => {
    const quotation = await makeSentQuotation();

    await expect(
      rejectQuotationService(actor, { quotationId: quotation.id, lostReason: "they_were_rude" }),
    ).rejects.toThrow(/not one of the loss reasons/);
  }, 60_000);
});
