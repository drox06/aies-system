import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInquiryService, transitionInquiryService } from "@/server/core/crm/inquiry-service";
import {
  checkQuotationTransition,
  isEditable,
  isRevisable,
  quotationTransitionsFrom,
} from "@/server/core/quotation/quotation-lifecycle";
import {
  createDraftForInquiry,
  createQuotationService,
  getQuotationService,
  QUOTATION_COST_FIELDS,
  QUOTATION_LINE_COST_FIELDS,
  stripQuotationCosts,
} from "@/server/core/quotation/quotation-service";

/**
 * specs/02-quotation.md, session 1's slice: the draft created from an inquiry, and the cost gate.
 *
 * The cost-gate test is also **module 00's deferred review-gate item**. That gate asked for "a
 * non-privileged role cannot see cost fields in the serialised response" and could not be run,
 * because module 00 had no cost field to hide. It does now.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `qowner-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Quote Test" };

const accountIds: string[] = [];
const inquiryIds: string[] = [];
const quotationIds: string[] = [];

async function makeAccount() {
  const account = await db.customerAccount.create({
    data: { code: `QT-${randomUUID().slice(0, 12)}`, name: `Quote Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...inquiryIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("§5's immutability, as a transition map", () => {
  it("has no way back to draft from sent — revising is the only route", () => {
    // The rule the whole model is shaped around: "A `sent` quotation is immutable."
    const back = checkQuotationTransition("sent", "draft");
    expect(back.ok).toBe(false);
    expect(quotationTransitionsFrom("sent")).not.toContain("draft");
  });

  it("only a draft is editable", () => {
    expect(isEditable("draft")).toBe(true);
    for (const status of ["pending_approval", "approved", "sent", "accepted"]) {
      expect(isEditable(status), status).toBe(false);
    }
  });

  it("offers revision from the statuses a customer has already seen", () => {
    for (const status of ["sent", "under_negotiation", "rejected", "expired"]) {
      expect(isRevisable(status), status).toBe(true);
    }
    expect(isRevisable("draft")).toBe(false);
  });

  it("will not let a person mark a quotation accepted by hand", () => {
    // §10: acceptance mirrors module 03's `customer_po.received`. It is a fact about the world.
    const byHand = checkQuotationTransition("sent", "accepted");
    expect(byHand.ok).toBe(false);
    expect(byHand.reason).toContain("customer's PO");
    expect(checkQuotationTransition("sent", "accepted", { bySystem: true }).ok).toBe(true);
  });

  it("tells a terminal quotation to revise rather than reopen", () => {
    const reopen = checkQuotationTransition("accepted", "draft");
    expect(reopen.ok).toBe(false);
    expect(reopen.reason).toContain("immutable");
  });
});

describe("the draft created when an inquiry reaches quoting (§10)", () => {
  async function inquiryAtQuoting(withAccount = true) {
    const account = withAccount ? await makeAccount() : null;
    const inquiry = await createInquiryService(actor, {
      subject: `Quoting test ${randomUUID().slice(0, 6)}`,
      accountId: account?.id ?? null,
      ownerId: OWNER,
      description: "Two DN100 flow meters, flanged PN16.",
      items: [],
    });
    inquiryIds.push(inquiry.id);
    for (const to of ["acknowledged", "evaluating", "quoting"]) {
      await transitionInquiryService(actor, { inquiryId: inquiry.id, to });
    }
    return inquiry;
  }

  it("creates one draft carrying the inquiry's own words as the starting scope", async () => {
    const inquiry = await inquiryAtQuoting();
    const result = await createDraftForInquiry({ inquiryId: inquiry.id });
    expect(result?.created).toBe(true);
    quotationIds.push(result!.quotationId);

    const quotation = await db.quotation.findUniqueOrThrow({
      where: { id: result!.quotationId },
    });
    expect(quotation.status).toBe("draft");
    expect(quotation.inquiryId).toBe(inquiry.id);
    // §1 calls the scope narrative what the customer actually reads; starting from what they asked
    // for beats starting from an empty box.
    expect(quotation.scopeOfWork).toContain("DN100");
    expect(quotation.number).toMatch(/^AIESLQ\d{6}$/);
  });

  it("is idempotent, because the queue delivers at least once", async () => {
    // A redelivered event must not issue a second quotation number against the same work.
    const inquiry = await inquiryAtQuoting();
    const first = await createDraftForInquiry({ inquiryId: inquiry.id });
    quotationIds.push(first!.quotationId);

    const second = await createDraftForInquiry({ inquiryId: inquiry.id });
    expect(second?.created).toBe(false);
    expect(second?.quotationId).toBe(first?.quotationId);

    const count = await db.quotation.count({ where: { inquiryId: inquiry.id } });
    expect(count).toBe(1);
  });

  it("waits when the inquiry has no account yet", async () => {
    // Module 01 §2 makes accountId optional on purpose — there is nothing to quote to yet.
    const inquiry = await inquiryAtQuoting(false);
    expect(await createDraftForInquiry({ inquiryId: inquiry.id })).toBeNull();
  });

  it("ignores an inquiry that no longer exists rather than throwing in a job handler", async () => {
    expect(await createDraftForInquiry({ inquiryId: "does-not-exist" })).toBeNull();
  });
});

describe("cost and margin never reach an unprivileged caller (§12, and module 00's deferred gate)", () => {
  it("strips every cost field from the serialised response, header and lines", async () => {
    const account = await makeAccount();
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Cost gate",
    });
    quotationIds.push(quotation.id);

    await db.quotationLine.create({
      data: {
        quotationId: quotation.id,
        lineNo: 1,
        description: "Flow meter",
        quantity: "1",
        unitCost: "1000.00",
        unitPrice: "1250.00",
        lineTotal: "1250.00",
        lineCost: "1000.00",
        lineMargin: "250.00",
      },
    });

    const withoutCost = (await getQuotationService(
      { id: OWNER, permissions: new Set(["quotation.view"]) },
      quotation.id,
    )) as Record<string, unknown> & { lines: Record<string, unknown>[] };

    // Inspect the payload, not the page. §4.3: hiding a field in the UI is not access control.
    for (const field of QUOTATION_COST_FIELDS) {
      expect(withoutCost, `header.${field}`).not.toHaveProperty(field);
    }
    for (const field of QUOTATION_LINE_COST_FIELDS) {
      expect(withoutCost.lines[0], `line.${field}`).not.toHaveProperty(field);
    }
    // The customer-facing figures must survive, or the quote is unreadable.
    expect(withoutCost).toHaveProperty("total");
    expect(withoutCost.lines[0]).toHaveProperty("unitPrice");
    expect(withoutCost.lines[0]).toHaveProperty("lineTotal");

    const withCost = (await getQuotationService(
      { id: OWNER, permissions: new Set(["quotation.view", "finance.view_cost"]) },
      quotation.id,
    )) as Record<string, unknown> & { lines: Record<string, unknown>[] };

    for (const field of QUOTATION_COST_FIELDS) {
      expect(withCost, `header.${field}`).toHaveProperty(field);
    }
    expect(withCost.lines[0]).toHaveProperty("unitCost");
  });

  it("strips lines even when the caller asks for a bare object", () => {
    // The gate is a function, not a query shape, so a future caller assembling its own payload
    // cannot accidentally skip it.
    const stripped = stripQuotationCosts(
      {
        id: "q1",
        total: "100.00",
        totalCost: "80.00",
        lines: [{ unitCost: "80.00", unitPrice: "100.00" }],
      },
      new Set(),
    ) as { lines: Record<string, unknown>[] };

    expect(stripped).not.toHaveProperty("totalCost");
    expect(stripped.lines[0]).not.toHaveProperty("unitCost");
    expect(stripped.lines[0]).toHaveProperty("unitPrice");
  });

  it("scopes reads: another preparer's quotation is a 404, not a 403", async () => {
    const account = await makeAccount();
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Someone else's",
    });
    quotationIds.push(quotation.id);

    // A 403 would confirm the record exists to somebody not allowed to know that.
    await expect(
      getQuotationService(
        { id: `other-${suffix}`, permissions: new Set(["quotation.view"]) },
        quotation.id,
      ),
    ).rejects.toThrow(/no longer exists/);

    const asLeadership = await getQuotationService(
      { id: `other-${suffix}`, permissions: new Set(["quotation.view", "quotation.view_all"]) },
      quotation.id,
    );
    expect(asLeadership).toHaveProperty("id", quotation.id);
  });
});
