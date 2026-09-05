import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  issueStatementService,
  raiseStatementService,
  recordPaymentService,
} from "@/server/core/finance/invoice-service";
import {
  buildBillingStatementPdfProps,
  buildStatementOfAccountPdfProps,
  renderBillingStatementPdf,
  renderStatementOfAccountPdf,
} from "@/server/core/finance/pdf/render";

/**
 * docs/DECISIONS.md #181 — §3's Billing Statement had no PDF at all, and §3.3/§5's "Statement of
 * account PDF per customer, generated on demand" did not exist either. Both against the real database,
 * following the same split the rest of the PDF suite uses: content assertions on the built props
 * (`@react-pdf` compresses and font-subsets its output, so text cannot be grepped back out of it),
 * bytes only proved real via the `%PDF-`/`%%EOF`/size smoke test.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `stpdf-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const statementIds: string[] = [];
const paymentIds: string[] = [];

async function makeAccount(over: { withholdsEWT?: boolean; ewtRate?: string } = {}) {
  const account = await db.customerAccount.create({
    data: {
      code: `STPDF-${randomUUID().slice(0, 10)}`,
      name: `Statement PDF Co ${randomUUID().slice(0, 6)}`,
      tin: "123-456-789-000",
      ownerId: actor.actorId,
      billingAddress: { line1: "1 Ortigas Avenue", city: "Pasig City" },
      withholdsEWT: over.withholdsEWT ?? false,
      ewtRate: over.ewtRate ?? "2",
    },
  });
  accountIds.push(account.id);
  return account;
}

async function raise(
  accountId: string,
  unitPrice: number,
  over: { dueDate?: Date; poReference?: string } = {},
) {
  const raised = await raiseStatementService(actor, {
    accountId,
    dueDate: over.dueDate ?? new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    poReference: over.poReference,
    lines: [{ description: "Calibration services rendered", quantity: 2, unitPrice }],
  });
  statementIds.push(raised.id);
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

describe("the billing statement PDF — §3's demand for payment, which never existed as a document", () => {
  it("carries what a customer needs to pay, and renders a real PDF", async () => {
    const account = await makeAccount();
    const raised = await raise(account.id, 50_000, { poReference: "PO-9931" });
    await issueStatementService(actor, { statementId: raised.id });

    const props = await buildBillingStatementPdfProps(raised.id);
    expect(props.statement.number).toBe(raised.number);
    expect(props.statement.status).toBe("issued");
    expect(props.statement.total).toBe(112_000);
    expect(props.statement.poReference).toBe("PO-9931");
    expect(props.customer.name).toContain("Statement PDF Co");
    expect(props.customer.tin).toBe("123-456-789-000");
    expect(props.lines).toHaveLength(1);
    expect(props.lines[0]!.lineTotal).toBe(100_000);

    const buffer = await renderBillingStatementPdf(raised.id);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.toString("latin1")).toContain("%%EOF");
    expect(buffer.length).toBeGreaterThan(50_000);
  }, 60_000);

  it("expects a withholding customer to pay less, until something is actually paid", async () => {
    const account = await makeAccount({ withholdsEWT: true, ewtRate: "2" });
    const raised = await raise(account.id, 100_000);
    await issueStatementService(actor, { statementId: raised.id });

    const beforePayment = await buildBillingStatementPdfProps(raised.id);
    expect(beforePayment.customer.withholdsEWT).toBe(true);
    expect(beforePayment.statement.amountPaid).toBe(0);
    expect(beforePayment.statement.expectedWithholdingAmount).toBeGreaterThan(0);
    expect(beforePayment.statement.expectedNetCollectible).toBe(
      beforePayment.statement.total - beforePayment.statement.expectedWithholdingAmount,
    );

    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: beforePayment.statement.expectedNetCollectible,
      withholdingTaxAmount: beforePayment.statement.expectedWithholdingAmount,
      reference: "BDO-STPDF-1",
    });
    paymentIds.push(payment.paymentId);

    const afterPayment = await buildBillingStatementPdfProps(raised.id);
    expect(afterPayment.statement.amountPaid).toBeGreaterThan(0);
  }, 60_000);

  it("renders a draft, unissued and watermarked as such, without throwing", async () => {
    const account = await makeAccount();
    const raised = await raise(account.id, 20_000);

    const props = await buildBillingStatementPdfProps(raised.id);
    expect(props.statement.status).toBe("draft");

    const buffer = await renderBillingStatementPdf(raised.id);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);

  it("renders a cancelled statement, marked, rather than refusing it", async () => {
    const account = await makeAccount();
    const raised = await raise(account.id, 20_000);
    await db.billingStatement.update({
      where: { id: raised.id },
      data: { status: "cancelled", cancelledReason: "Raised against the wrong milestone." },
    });

    const props = await buildBillingStatementPdfProps(raised.id);
    expect(props.statement.status).toBe("cancelled");
    expect(props.statement.cancelledReason).toBe("Raised against the wrong milestone.");

    const buffer = await renderBillingStatementPdf(raised.id);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);

  it("refuses a deleted statement rather than printing one nobody can act on", async () => {
    const account = await makeAccount();
    const raised = await raise(account.id, 20_000);
    await db.billingStatement.update({ where: { id: raised.id }, data: { deletedAt: new Date() } });

    await expect(buildBillingStatementPdfProps(raised.id)).rejects.toThrow(/no longer exists/);
  }, 60_000);
});

describe("the statement of account PDF — §3.3/§5's aggregate, generated fresh on every request", () => {
  it("shows only what is actually open — not drafts, not paid, not cancelled", async () => {
    const account = await makeAccount();

    const draft = await raise(account.id, 10_000);
    // Left as a draft — never issued.
    void draft;

    const paid = await raise(account.id, 30_000);
    await issueStatementService(actor, { statementId: paid.id });
    const paidStatement = await db.billingStatement.findUniqueOrThrow({ where: { id: paid.id } });
    const payment = await recordPaymentService(actor, {
      accountId: account.id,
      receivedAt: new Date(),
      method: "bank_transfer",
      amount: paidStatement.total,
      reference: "BDO-STPDF-2",
    });
    paymentIds.push(payment.paymentId);

    const cancelled = await raise(account.id, 15_000);
    await issueStatementService(actor, { statementId: cancelled.id });
    await db.billingStatement.update({
      where: { id: cancelled.id },
      data: { status: "cancelled" },
    });

    const open = await raise(account.id, 40_000, {
      dueDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    await issueStatementService(actor, { statementId: open.id });

    const props = await buildStatementOfAccountPdfProps(account.id);
    const numbers = props.rows.map((row) => row.number);
    expect(numbers).toEqual([open.number]);
    expect(props.rows[0]!.bucket).toBe("1-30");
    expect(props.totalOutstanding).toBe(props.rows[0]!.balance);
  }, 60_000);

  it("says so, and still renders, when nothing is outstanding", async () => {
    const account = await makeAccount();

    const props = await buildStatementOfAccountPdfProps(account.id);
    expect(props.rows).toHaveLength(0);
    expect(props.totalOutstanding).toBe(0);

    const buffer = await renderStatementOfAccountPdf(account.id);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.toString("latin1")).toContain("%%EOF");
  }, 60_000);

  it("renders a real PDF with a populated ageing table", async () => {
    const account = await makeAccount();
    const first = await raise(account.id, 25_000, {
      dueDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    });
    await issueStatementService(actor, { statementId: first.id });
    const second = await raise(account.id, 10_000);
    await issueStatementService(actor, { statementId: second.id });

    const props = await buildStatementOfAccountPdfProps(account.id);
    expect(props.rows).toHaveLength(2);
    expect(props.buckets["31-60"]).toBeGreaterThan(0);
    expect(props.buckets.current).toBeGreaterThan(0);

    const buffer = await renderStatementOfAccountPdf(account.id);
    expect(buffer.length).toBeGreaterThan(50_000);
  }, 60_000);

  it("refuses a deleted account", async () => {
    const account = await makeAccount();
    await db.customerAccount.update({ where: { id: account.id }, data: { deletedAt: new Date() } });

    await expect(buildStatementOfAccountPdfProps(account.id)).rejects.toThrow(/no longer exists/);
  }, 60_000);
});
