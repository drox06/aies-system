import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bounceChequeService,
  cancelInvoiceService,
  cancelStatementService,
  clearChequeService,
  issueStatementService,
  outstanding2307sService,
  raiseStatementService,
  recordPaymentService,
} from "@/server/core/finance/invoice-service";

/**
 * specs/05-finance-billing.md §3, against the real database.
 *
 * §3 calls itself the most important section of the module, and the reason is one confirmed fact:
 * **AIES issues a Service Invoice upon payment, not upon billing.** Getting it wrong creates a VAT
 * liability on money that has not arrived — twelve per cent handed to the BIR months before the
 * customer pays, if they ever do.
 *
 * So these tests are mostly about *when* the invoice exists, and what happens when the money turns
 * out not to be real.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `inv-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const statementIds: string[] = [];
const paymentIds: string[] = [];

async function makeAccount(over: { withholdsEWT?: boolean; ewtRate?: string } = {}) {
  const account = await db.customerAccount.create({
    data: {
      code: `INV-${randomUUID().slice(0, 12)}`,
      name: `Invoice Co ${randomUUID().slice(0, 6)}`,
      ownerId: actor.actorId,
      withholdsEWT: over.withholdsEWT ?? false,
      ewtRate: over.ewtRate ?? "2",
    },
  });
  accountIds.push(account.id);
  return account;
}

/** A statement already sent to the customer, which is the only kind money can settle. */
async function issuedStatement(
  accountId: string,
  unitPrice: number,
  over: { dueDate?: Date; vatMode?: "exclusive" | "inclusive" | "zero_rated" | "exempt" } = {},
) {
  const raised = await raiseStatementService(actor, {
    accountId,
    dueDate: over.dueDate ?? new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    vatMode: over.vatMode ?? "exclusive",
    lines: [{ description: "Work done", quantity: 1, unitPrice }],
  });
  statementIds.push(raised.id);
  await issueStatementService(actor, { statementId: raised.id });
  return raised;
}

afterAll(async () => {
  await db.serviceInvoice.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.actorId } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("raising the document that asks for money", () => {
  it("computes VAT, and records what the customer will withhold", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      dueDate: new Date("2026-12-31"),
      lines: [{ description: "Calibration", quantity: 2, unitPrice: 50_000 }],
    });
    statementIds.push(raised.id);

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });

    expect(statement.subtotal).toBe(100_000);
    expect(statement.vatAmount).toBe(12_000);
    expect(statement.total).toBe(112_000);

    // Withholding on sales net of VAT — 2% of 100,000, not of 112,000.
    expect(statement.expectedWithholdingAmount).toBe(2_000);
    expect(statement.expectedNetCollectible).toBe(110_000);

    // Raised as a draft: nothing has gone to anybody yet.
    expect(statement.status).toBe("draft");
  });

  it("refuses a statement with no lines", async () => {
    const account = await makeAccount();
    await expect(
      raiseStatementService(actor, {
        accountId: account.id,
        dueDate: new Date("2026-12-31"),
        lines: [],
      }),
    ).rejects.toThrow(/without saying what for/);
  });

  it("can be withdrawn freely while nothing has been paid", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 50_000);

    await cancelStatementService(actor, {
      statementId: raised.id,
      reason: "Wrong customer contact, reissuing.",
    });

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.status).toBe("cancelled");
  });
});

describe("the two-way rule", () => {
  /**
   * §3.1: "A payment cannot be recorded without producing an invoice, and an invoice cannot exist
   * without a payment."
   */
  it("issues exactly one service invoice when a payment is recorded", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 112_000,
      reference: "BDO-1",
    });
    paymentIds.push(result.paymentId);

    expect(result.serviceInvoiceId).not.toBeNull();
    expect(result.serviceInvoiceNumber).toMatch(/^AIESSI-/);

    const invoices = await db.serviceInvoice.findMany({ where: { paymentId: result.paymentId } });
    expect(invoices).toHaveLength(1);

    const invoice = invoices[0]!;
    expect(invoice.vatableSales).toBe(100_000);
    expect(invoice.vatAmount).toBe(12_000);
    expect(invoice.netAmountReceived).toBe(112_000);

    // And the statement is settled.
    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.status).toBe("paid");
    expect(statement.balance).toBe(0);
  });

  it("deducts withholding and records it against the invoice", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    await issuedStatement(account.id, 100_000);

    // ₱112,000 billed, ₱2,000 withheld, ₱110,000 arrives.
    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 110_000,
      withholdingTaxAmount: 2_000,
    });
    paymentIds.push(result.paymentId);
    expect(result.withholdingWarning).toBeNull();

    const invoice = await db.serviceInvoice.findFirstOrThrow({
      where: { paymentId: result.paymentId },
    });
    expect(invoice.withholdingTaxAmount).toBe(2_000);
    expect(invoice.netAmountReceived).toBe(110_000);
    expect(invoice.grossAmount).toBe(112_000);
  });

  /** §3.1 step 2: flagged, not refused. Their figure is what arrived. */
  it("flags a withholding that differs from expectation, and records it anyway", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 107_000,
      withholdingTaxAmount: 5_000,
    });
    paymentIds.push(result.paymentId);

    expect(result.withholdingWarning).toMatch(/their rate has changed/);
    // Still recorded — the money arrived as it arrived.
    const invoice = await db.serviceInvoice.findFirstOrThrow({
      where: { paymentId: result.paymentId },
    });
    expect(invoice.withholdingTaxAmount).toBe(5_000);
  });

  it("splits one payment across two statements and issues one invoice covering both", async () => {
    const account = await makeAccount();
    const older = await issuedStatement(account.id, 50_000, {
      dueDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const newer = await issuedStatement(account.id, 50_000, {
      dueDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    });

    // 56,000 + 56,000 = 112,000 due in total.
    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 112_000,
    });
    paymentIds.push(result.paymentId);

    const invoices = await db.serviceInvoice.findMany({ where: { paymentId: result.paymentId } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.billingStatementIds).toHaveLength(2);

    for (const id of [older.id, newer.id]) {
      const statement = await db.billingStatement.findUniqueOrThrow({ where: { id } });
      expect(statement.status).toBe("paid");
    }
  });

  it("leaves a statement partially paid when the money does not cover it", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 50_000,
    });
    paymentIds.push(result.paymentId);

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.status).toBe("partially_paid");
    expect(statement.balance).toBe(62_000);
  });

  /** §11: "over-allocation is rejected". */
  it("refuses an allocation larger than the statement is owed", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 50_000);

    await expect(
      recordPaymentService(actor, {
        accountId: account.id,
        receivedAt: new Date(),
        method: "bank_transfer",
        amount: 200_000,
        allocations: [{ billingStatementId: raised.id, amount: 200_000 }],
      }),
    ).rejects.toThrow(/overpaid into credit/);
  });
});

describe("a post-dated cheque", () => {
  /**
   * §3.3: "A received PDC is *not* collected cash." No invoice, no settlement, until it clears.
   * Issuing on receipt would declare a sale against money that may bounce.
   */
  it("settles nothing and issues nothing until it clears", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "check",
      amount: 112_000,
      checkNumber: "0012345",
      checkDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    paymentIds.push(result.paymentId);

    expect(result.collected).toBe(false);
    expect(result.serviceInvoiceId).toBeNull();

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.amountPaid).toBe(0);
    expect(statement.status).toBe("issued");

    // Clearing is what makes the money real.
    const cleared = await clearChequeService(actor, { paymentId: result.paymentId });
    expect(cleared.serviceInvoiceNumber).toMatch(/^AIESSI-/);

    const settled = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(settled.status).toBe("paid");
  });

  it("insists on a cheque number", async () => {
    const account = await makeAccount();
    await expect(
      recordPaymentService(actor, {
        accountId: account.id,
        receivedAt: new Date(),
        method: "check",
        amount: 10_000,
      }),
    ).rejects.toThrow(/needs its number/);
  });

  /**
   * §11: "a bounced check reverses cleanly **without leaving an orphaned invoice number**."
   *
   * Because no invoice is issued until a cheque clears, a bounce before clearing has no number to
   * orphan — which is the deeper reason §3.3 wants the PDC held, rather than a design detail.
   */
  it("bounces before clearing with no invoice number to orphan", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "check",
      amount: 112_000,
      checkNumber: "0099999",
    });
    paymentIds.push(result.paymentId);

    await bounceChequeService(actor, {
      paymentId: result.paymentId,
      reason: "Drawn against insufficient funds",
    });

    expect(await db.serviceInvoice.count({ where: { paymentId: result.paymentId } })).toBe(0);

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.status).toBe("issued");
    expect(statement.amountPaid).toBe(0);
  });

  /**
   * A cheque that bounces *after* clearing is a different act: the BIR document exists and has been
   * declared, so it is cancelled and **retained**, never deleted, and the statement goes back to
   * owing.
   */
  it("cancels but retains the invoice when a cleared cheque bounces", async () => {
    const account = await makeAccount();
    const raised = await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "check",
      amount: 112_000,
      checkNumber: "0088888",
    });
    paymentIds.push(result.paymentId);
    const cleared = await clearChequeService(actor, { paymentId: result.paymentId });

    await bounceChequeService(actor, {
      paymentId: result.paymentId,
      reason: "Returned by the bank after clearing",
    });

    const invoice = await db.serviceInvoice.findUniqueOrThrow({
      where: { id: cleared.serviceInvoiceId },
    });
    expect(invoice.status).toBe("cancelled");
    // Retained, with its number intact.
    expect(invoice.number).toBe(cleared.serviceInvoiceNumber);
    expect(invoice.cancellationReason).toMatch(/bounced/);

    const statement = await db.billingStatement.findUniqueOrThrow({ where: { id: raised.id } });
    expect(statement.amountPaid).toBe(0);
    expect(statement.status).not.toBe("paid");
  });

  it("refuses to clear a cheque twice", async () => {
    const account = await makeAccount();
    await issuedStatement(account.id, 20_000);
    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "check",
      amount: 22_400,
      checkNumber: "0077777",
    });
    paymentIds.push(result.paymentId);

    await clearChequeService(actor, { paymentId: result.paymentId });
    await expect(clearChequeService(actor, { paymentId: result.paymentId })).rejects.toThrow(
      /already cleared/,
    );
  });
});

describe("a cancelled invoice", () => {
  /** §3: "retained and marked, never deleted or renumbered." */
  it("keeps its number and its row", async () => {
    const account = await makeAccount();
    await issuedStatement(account.id, 30_000);
    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 33_600,
    });
    paymentIds.push(result.paymentId);

    await cancelInvoiceService(actor, {
      serviceInvoiceId: result.serviceInvoiceId!,
      reason: "Issued against the wrong account by mistake.",
    });

    const invoice = await db.serviceInvoice.findUniqueOrThrow({
      where: { id: result.serviceInvoiceId! },
    });
    expect(invoice.status).toBe("cancelled");
    expect(invoice.number).toBe(result.serviceInvoiceNumber);
  });

  it("insists on a reason somebody can read years later", async () => {
    const account = await makeAccount();
    await issuedStatement(account.id, 10_000);
    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 11_200,
    });
    paymentIds.push(result.paymentId);

    await expect(
      cancelInvoiceService(actor, { serviceInvoiceId: result.serviceInvoiceId!, reason: "no" }),
    ).rejects.toThrow(/read years later/);
  });
});

describe("the 2307 chase list", () => {
  /**
   * §3.2: "Unrecovered 2307s are real money — they are creditable against income tax and worthless
   * if never collected."
   */
  it("lists withholding with no certificate on file, with its age", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      method: "bank_transfer",
      amount: 110_000,
      withholdingTaxAmount: 2_000,
    });
    paymentIds.push(result.paymentId);

    const chase = await outstanding2307sService();
    const mine = chase.find((row) => row.paymentId === result.paymentId);

    expect(mine).toBeDefined();
    expect(mine!.withholdingTaxAmount).toBe(2_000);
    expect(mine!.daysOutstanding).toBeGreaterThanOrEqual(44);
  });

  it("drops off the list once the certificate is on file", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    await issuedStatement(account.id, 100_000);

    const result = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: 110_000,
      withholdingTaxAmount: 2_000,
      form2307FileId: "file-abc",
    });
    paymentIds.push(result.paymentId);

    const chase = await outstanding2307sService();
    expect(chase.find((row) => row.paymentId === result.paymentId)).toBeUndefined();
  });
});
