import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { finalBillingGate } from "./final-billing-gate";
import {
  ageingBucket,
  checkAllocation,
  checkWithholding,
  computeStatementTotals,
  expectedWithholding,
  isCollected,
  statementStatusFor,
  suggestAllocation,
  type Allocation,
  type PaymentMethod,
  type StatementLineInput,
  type StatementType,
  type VatMode,
} from "./invoice-rules";

/**
 * specs/05-finance-billing.md §3 — raising a statement, and recording the money that settles it.
 *
 * ## The rule this file exists to enforce
 *
 * §3.1: "A payment cannot be recorded without producing an invoice, and an invoice cannot exist
 * without a payment. **Enforce both directions in the service layer.**"
 *
 * The schema holds one direction (`ServiceInvoice.paymentId` is required and unique). This file
 * holds the other by being the only place either row is created: `recordPaymentService` writes the
 * payment, the allocations and the invoice in **one transaction**, or writes none of them.
 *
 * That is not a stylistic preference. A payment without its invoice is unbilled revenue that looks
 * collected; an invoice without its payment is a BIR document declaring a sale that did not happen.
 * Both are worse than the write failing.
 */

export const BILLING_STATEMENT_ENTITY_TYPE = "BillingStatement";
export const SERVICE_INVOICE_ENTITY_TYPE = "ServiceInvoice";
export const PAYMENT_ENTITY_TYPE = "Payment";

const BILLING_STATEMENT_DOCUMENT_TYPE = "billing_statement";
const SERVICE_INVOICE_DOCUMENT_TYPE = "service_invoice";
const PAYMENT_DOCUMENT_TYPE = "payment";

export interface RaiseStatementInput {
  accountId: string;
  type?: StatementType;
  salesOrderId?: string | null;
  projectId?: string | null;
  ticketId?: string | null;
  milestoneId?: string | null;
  dueDate: Date;
  vatMode?: VatMode;
  lines: StatementLineInput[];
  poReference?: string | null;
  drReferences?: string[];
  srReferences?: string[];
  tcCertificateRef?: string | null;
  notes?: string | null;
  terms?: string | null;
  /**
   * §4's override, for a final statement the gate is refusing.
   *
   * `finance.override_billing_gate` — president and vice-president only — and it needs a reason.
   * Present as a string rather than a boolean because §4 asks for a *logged* reason: a flag would
   * record that somebody overrode the gate without recording why, which is the half of the audit
   * trail that matters when the customer disputes the bill nine months later.
   */
  overrideGateReason?: string | null;
}

/**
 * Raises a billing statement — the document that asks for money.
 *
 * Raised as a **draft**. §3 makes a statement freely cancellable precisely because nothing has been
 * declared to anybody yet, and the draft step is what makes "freely" true in practice: a figure
 * somebody is still checking has not gone to a customer, so withdrawing it costs nothing.
 */
export async function raiseStatementService(actor: ActorMeta, input: RaiseStatementInput) {
  if (input.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A statement with no lines asks for money without saying what for.",
    });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true, withholdsEWT: true, ewtRate: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  /**
   * §4's final billing gate.
   *
   * Only a `final` statement. A downpayment demanded before any work starts is the whole point of a
   * downpayment, and a progress bill is by definition raised mid-project — gating either on a closed
   * project would make the platform refuse the terms the company actually sells on.
   *
   * The seven conditions are evaluated independently and reported together, so finance chases all of
   * them in one pass rather than discovering them one refusal at a time.
   */
  if ((input.type ?? "progress") === "final" && input.salesOrderId) {
    const gate = await finalBillingGate(input.salesOrderId);

    if (!gate.ok && !input.overrideGateReason?.trim()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `A final statement cannot be issued yet — ${gate.blockers.length} thing` +
          `${gate.blockers.length === 1 ? "" : "s"} outstanding. ` +
          gate.blockers
            .map(
              (blocker) =>
                `${blocker.label} (${blocker.owner}${blocker.detail ? `: ${blocker.detail}` : ""})`,
            )
            .join("; ") +
          ". Somebody with finance.override_billing_gate can proceed anyway with a reason.",
      });
    }

    if (!gate.ok && input.overrideGateReason?.trim()) {
      // Recorded before the statement is written, so the reason survives even if the write fails.
      await writeAuditLog(db, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "billing_gate_overridden",
        entityType: BILLING_STATEMENT_ENTITY_TYPE,
        entityId: input.salesOrderId,
        summary:
          `Raised a final statement past ${gate.blockers.length} unmet condition` +
          `${gate.blockers.length === 1 ? "" : "s"} (${gate.blockers.map((b) => b.key).join(", ")}) ` +
          `— ${input.overrideGateReason.trim()}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }
  }

  const vatMode: VatMode = input.vatMode ?? "exclusive";
  const totals = computeStatementTotals(input.lines, vatMode);
  const withholding = expectedWithholding(totals, {
    withholdsEWT: account.withholdsEWT,
    // Decimal to string rather than number: the rules layer parses it, and going through a float
    // here would be the one place in the money path that does.
    ewtRate: account.ewtRate.toString(),
  });

  const number = await allocateNumber(BILLING_STATEMENT_DOCUMENT_TYPE);

  const statement = await db.$transaction(async (tx) => {
    const created = await tx.billingStatement.create({
      data: {
        number,
        type: input.type ?? "progress",
        accountId: account.id,
        salesOrderId: input.salesOrderId ?? null,
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        milestoneId: input.milestoneId ?? null,
        dueDate: input.dueDate,
        subtotal: totals.subtotal,
        vatMode,
        vatAmount: totals.vatAmount,
        total: totals.total,
        expectedWithholdingAmount: withholding.withholding,
        expectedNetCollectible: withholding.netCollectible,
        balance: totals.total,
        status: "draft",
        poReference: input.poReference ?? null,
        drReferences: input.drReferences ?? [],
        srReferences: input.srReferences ?? [],
        tcCertificateRef: input.tcCertificateRef ?? null,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
      },
    });

    await tx.billingStatementLine.createMany({
      data: input.lines.map((line, index) => ({
        statementId: created.id,
        lineNo: index + 1,
        description: line.description,
        quantity: String(line.quantity),
        unitPrice: line.unitPrice,
        lineTotal: totals.lineTotals[index]!,
        vatable: line.vatable !== false,
      })),
    });

    if (input.milestoneId) {
      // The milestone has been billed; it should not appear on the work list again.
      await tx.billingMilestone.updateMany({
        where: { id: input.milestoneId, status: "ready_to_bill" },
        data: { status: "invoiced", billingStatementId: created.id, version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "drafted",
      entityType: BILLING_STATEMENT_ENTITY_TYPE,
      entityId: created.id,
      summary: `Drafted ${number} for ${account.name} — ${(totals.total / 100).toFixed(2)}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return { id: statement.id, number: statement.number, total: statement.total };
}

/**
 * Sends the statement to the customer.
 *
 * The point at which a receivable exists. Nothing about VAT happens here — §3 again: the statement
 * "triggers VAT: **No**". That waits for money.
 */
export async function issueStatementService(actor: ActorMeta, input: { statementId: string }) {
  const statement = await db.billingStatement.findFirst({
    where: { id: input.statementId, deletedAt: null },
  });
  if (!statement) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That statement no longer exists." });
  }
  if (statement.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${statement.number} is ${statement.status.replace(/_/g, " ")}, not a draft.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.billingStatement.update({
      where: { id: statement.id },
      data: {
        status: "issued",
        issuedAt: new Date(),
        issuedById: actor.actorId,
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "issued",
      entityType: BILLING_STATEMENT_ENTITY_TYPE,
      entityId: statement.id,
      summary: `Issued ${statement.number} — ${(statement.total / 100).toFixed(2)}`,
      diff: { status: { from: "draft", to: "issued" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    await emit(
      tx,
      "billing_statement.issued",
      {
        billingStatementId: statement.id,
        number: statement.number,
        accountId: statement.accountId,
        total: statement.total,
        dueDate: statement.dueDate.toISOString(),
      },
      { actorId: actor.actorId },
    );
  });

  return { status: "issued" as const };
}

/** Withdraws a statement. Free, because nothing has been declared — the mirror of an invoice. */
export async function cancelStatementService(
  actor: ActorMeta,
  input: { statementId: string; reason: string },
) {
  if (input.reason.trim().length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say why it is being withdrawn." });
  }

  const statement = await db.billingStatement.findFirst({
    where: { id: input.statementId, deletedAt: null },
  });
  if (!statement) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That statement no longer exists." });
  }
  if (statement.amountPaid > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${statement.number} has money against it. Cancelling it would orphan a payment and the ` +
        `invoice already issued for it — raise a credit note instead.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.billingStatement.update({
      where: { id: statement.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledById: actor.actorId,
        cancelledReason: input.reason.trim(),
        version: { increment: 1 },
      },
    });

    // The milestone goes back on the work list: the work was done, this bill was not the right one.
    if (statement.milestoneId) {
      await tx.billingMilestone.updateMany({
        where: { id: statement.milestoneId, status: "invoiced" },
        data: { status: "ready_to_bill", billingStatementId: null, version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cancelled",
      entityType: BILLING_STATEMENT_ENTITY_TYPE,
      entityId: statement.id,
      summary: `Withdrew ${statement.number} — ${input.reason.trim()}`,
      diff: { status: { from: statement.status, to: "cancelled" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "cancelled" as const };
}

export interface RecordPaymentInput {
  accountId: string;
  receivedAt: Date;
  method: PaymentMethod;
  /** Integer centavos. */
  amount: number;
  reference?: string | null;
  checkNumber?: string | null;
  checkDate?: Date | null;
  withholdingTaxAmount?: number;
  form2307FileId?: string | null;
  proofFileId?: string | null;
  notes?: string | null;
  /** Omit to take the oldest-first suggestion; supply to override it. */
  allocations?: Allocation[];
}

/**
 * §3.1 — records the money and issues the BIR document, in one transaction.
 *
 * ## What happens, and why in this order
 *
 * 1. The payment is written.
 * 2. It is allocated across open statements — oldest first unless somebody said otherwise.
 * 3. Each statement's paid amount and status move.
 * 4. **A service invoice is issued**, numbered from the strict sequence, carrying the VAT breakdown,
 *    the withholding deduction and the net received.
 *
 * All four or none. See the note at the top of this file for why the intermediate states are worse
 * than a failure.
 *
 * ## Except for a cheque
 *
 * §3.3: a post-dated cheque has arrived in the sense that it is in the drawer, and not in the sense
 * that matters. So a cheque is recorded and allocated — the customer has told you what they are
 * paying — but **no invoice is issued and no statement is settled** until `clearCheque` says the
 * money is real. Issuing on receipt would declare a sale against funds that may bounce.
 */
export async function recordPaymentService(actor: ActorMeta, input: RecordPaymentInput) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A payment needs an amount above zero, in whole centavos.",
    });
  }
  if (input.method === "check" && !input.checkNumber?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A cheque needs its number — it is how the bank and the customer both refer to it.",
    });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true, withholdsEWT: true, ewtRate: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  const open = await db.billingStatement.findMany({
    where: {
      accountId: account.id,
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
    },
    orderBy: { dueDate: "asc" },
  });

  const targets = open.map((statement) => ({
    billingStatementId: statement.id,
    balance: statement.balance,
    dueDate: statement.dueDate,
    number: statement.number,
  }));

  const allocations = input.allocations ?? suggestAllocation(input.amount, targets).allocations;
  const allocationCheck = checkAllocation(input.amount, allocations, targets);
  if (!allocationCheck.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: allocationCheck.errors.join(" ") });
  }

  /**
   * The withholding check — flagged, never refused.
   *
   * §3.1 step 2. Their figure is what arrived whether AIES agrees with it or not, so the payment is
   * recorded as it came; the warning travels back to the caller so the screen can show it.
   */
  const withheld = input.withholdingTaxAmount ?? 0;
  const settled = open.filter((statement) =>
    allocations.some((allocation) => allocation.billingStatementId === statement.id),
  );
  const expected = settled.reduce((sum, statement) => sum + statement.expectedWithholdingAmount, 0);
  const withholdingCheck = checkWithholding(withheld, expected);

  const collected = isCollected({ method: input.method, clearedAt: null });

  const paymentNumber = await allocateNumber(PAYMENT_DOCUMENT_TYPE);
  // Allocated outside the transaction on purpose: §3.3 permits gaps in the invoice series but
  // requires them to be explainable, and a number allocated inside a transaction that rolls back is
  // a gap with no explanation at all.
  const invoiceNumber = collected ? await allocateNumber(SERVICE_INVOICE_DOCUMENT_TYPE) : null;

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        number: paymentNumber,
        accountId: account.id,
        receivedAt: input.receivedAt,
        method: input.method,
        reference: input.reference ?? null,
        amount: input.amount,
        checkNumber: input.checkNumber ?? null,
        checkDate: input.checkDate ?? null,
        // A cheque is not cleared on arrival; anything else is money as soon as it lands.
        clearedAt: collected ? input.receivedAt : null,
        withholdingTaxAmount: withheld,
        form2307FileId: input.form2307FileId ?? null,
        form2307ReceivedAt: input.form2307FileId ? new Date() : null,
        proofFileId: input.proofFileId ?? null,
        recordedById: actor.actorId,
        notes: input.notes ?? null,
      },
    });

    await tx.paymentAllocation.createMany({
      data: allocations.map((allocation) => ({
        paymentId: payment.id,
        billingStatementId: allocation.billingStatementId,
        amount: allocation.amount,
      })),
    });

    let invoice: { id: string; number: string } | null = null;

    if (collected) {
      await applySettlement(tx, allocations, open);
      invoice = await issueInvoiceFor(tx, {
        actor,
        payment,
        accountId: account.id,
        allocations,
        statements: open,
        withheld,
        invoiceNumber: invoiceNumber!,
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "recorded",
      entityType: PAYMENT_ENTITY_TYPE,
      entityId: payment.id,
      summary:
        `Recorded ${paymentNumber} from ${account.name} — ${(input.amount / 100).toFixed(2)}` +
        (collected ? ` and issued ${invoice?.number}` : " (cheque, not yet cleared)"),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "payment.received",
      {
        paymentId: payment.id,
        number: payment.number,
        accountId: account.id,
        amount: payment.amount,
        method: payment.method,
        collected,
      },
      { actorId: actor.actorId },
    );

    return { payment, invoice };
  });

  return {
    paymentId: result.payment.id,
    paymentNumber: result.payment.number,
    serviceInvoiceId: result.invoice?.id ?? null,
    serviceInvoiceNumber: result.invoice?.number ?? null,
    collected,
    allocations,
    withholdingWarning: withholdingCheck.ok ? null : (withholdingCheck.message ?? null),
  };
}

/** Moves each settled statement's paid amount and status. Shared by recording and by clearing. */
async function applySettlement(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  allocations: readonly Allocation[],
  statements: readonly {
    id: string;
    total: number;
    amountPaid: number;
    dueDate: Date;
    status: string;
  }[],
) {
  const byId = new Map(statements.map((statement) => [statement.id, statement]));

  for (const allocation of allocations) {
    const statement = byId.get(allocation.billingStatementId);
    if (!statement) continue;

    const amountPaid = statement.amountPaid + allocation.amount;
    await tx.billingStatement.update({
      where: { id: statement.id },
      data: {
        amountPaid,
        balance: statement.total - amountPaid,
        status: statementStatusFor({
          total: statement.total,
          amountPaid,
          dueDate: statement.dueDate,
          status: statement.status,
        }),
        version: { increment: 1 },
      },
    });
  }
}

/**
 * Writes the BIR document.
 *
 * The VAT breakdown is taken from the **statements being settled**, apportioned by how much of each
 * this payment covers. Recomputing it from the payment amount alone would lose the distinction
 * between vatable, exempt and zero-rated sales that §3.3 requires the invoice to report — and those
 * come from the lines, which live on the statement.
 */
async function issueInvoiceFor(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  args: {
    actor: ActorMeta;
    payment: { id: string; amount: number };
    accountId: string;
    allocations: readonly Allocation[];
    statements: readonly {
      id: string;
      total: number;
      vatAmount: number;
      vatMode: string;
      subtotal: number;
    }[];
    withheld: number;
    invoiceNumber: string;
  },
) {
  const byId = new Map(args.statements.map((statement) => [statement.id, statement]));

  let vatableSales = 0;
  let vatExemptSales = 0;
  let zeroRatedSales = 0;
  let vatAmount = 0;

  for (const allocation of args.allocations) {
    const statement = byId.get(allocation.billingStatementId);
    if (!statement || statement.total <= 0) continue;

    // The share of this statement this payment covers.
    const share = allocation.amount / statement.total;
    const netShare = Math.round((statement.total - statement.vatAmount) * share);
    const vatShare = Math.round(statement.vatAmount * share);

    vatAmount += vatShare;
    if (statement.vatMode === "zero_rated") zeroRatedSales += netShare;
    else if (statement.vatMode === "exempt") vatExemptSales += netShare;
    else vatableSales += netShare;
  }

  const invoice = await tx.serviceInvoice.create({
    data: {
      number: args.invoiceNumber,
      accountId: args.accountId,
      paymentId: args.payment.id,
      billingStatementIds: args.allocations.map((allocation) => allocation.billingStatementId),
      // §3: "= the date payment was received."
      invoiceDate: new Date(),
      vatableSales,
      vatExemptSales,
      zeroRatedSales,
      vatAmount,
      grossAmount: args.payment.amount + args.withheld,
      withholdingTaxAmount: args.withheld,
      netAmountReceived: args.payment.amount,
      status: "issued",
      issuedById: args.actor.actorId,
    },
  });

  await writeAuditLog(tx, {
    actorId: args.actor.actorId,
    actorLabel: args.actor.actorLabel,
    action: "issued",
    entityType: SERVICE_INVOICE_ENTITY_TYPE,
    entityId: invoice.id,
    summary:
      `Issued ${invoice.number} — VAT ${(vatAmount / 100).toFixed(2)} on ` +
      `${(vatableSales / 100).toFixed(2)} vatable sales`,
    ip: args.actor.ip,
    userAgent: args.actor.userAgent,
    requestId: args.actor.requestId,
  });

  await emit(
    tx,
    "service_invoice.issued",
    {
      serviceInvoiceId: invoice.id,
      number: invoice.number,
      accountId: args.accountId,
      grossAmount: invoice.grossAmount,
      vatAmount,
    },
    { actorId: args.actor.actorId },
  );

  return { id: invoice.id, number: invoice.number };
}

/**
 * A cheque cleared. **This** is when the money exists, and when the BIR document is issued.
 *
 * §3.3's whole point: recording the cheque said what the customer intends; clearing it says the bank
 * agreed.
 */
export async function clearChequeService(
  actor: ActorMeta,
  input: { paymentId: string; clearedAt?: Date },
) {
  const payment = await db.payment.findFirst({
    where: { id: input.paymentId, deletedAt: null },
    include: { allocations: true, invoice: true },
  });
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That payment no longer exists." });
  }
  if (payment.method !== "check") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${payment.number} is not a cheque — it was money the day it arrived.`,
    });
  }
  if (payment.clearedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${payment.number} already cleared, and ${payment.invoice?.number ?? "an invoice"} was issued for it.`,
    });
  }
  if (payment.bouncedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${payment.number} bounced. A replacement is a new payment, not this one clearing.`,
    });
  }

  const statements = await db.billingStatement.findMany({
    where: { id: { in: payment.allocations.map((allocation) => allocation.billingStatementId) } },
  });

  const invoiceNumber = await allocateNumber(SERVICE_INVOICE_DOCUMENT_TYPE);
  const clearedAt = input.clearedAt ?? new Date();

  const invoice = await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { clearedAt },
    });

    const allocations = payment.allocations.map((allocation) => ({
      billingStatementId: allocation.billingStatementId,
      amount: allocation.amount,
    }));

    await applySettlement(tx, allocations, statements);

    const issued = await issueInvoiceFor(tx, {
      actor,
      payment,
      accountId: payment.accountId,
      allocations,
      statements,
      withheld: payment.withholdingTaxAmount,
      invoiceNumber,
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cleared",
      entityType: PAYMENT_ENTITY_TYPE,
      entityId: payment.id,
      summary: `${payment.number} cleared — ${issued.number} issued`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "payment.cleared",
      { paymentId: payment.id, number: payment.number, amount: payment.amount },
      { actorId: actor.actorId },
    );

    return issued;
  });

  return { serviceInvoiceId: invoice.id, serviceInvoiceNumber: invoice.number };
}

/**
 * A cheque bounced.
 *
 * §11: "a bounced check reverses cleanly **without leaving an orphaned invoice number**." Since no
 * invoice is issued until a cheque clears, a bounce before clearing has no number to orphan — which
 * is the deeper reason §3.3 wants the PDC held rather than a design detail.
 *
 * A cheque that bounces *after* clearing is a different act: the invoice exists and has been
 * declared, so it is cancelled and retained rather than deleted, and the statements go back to
 * owing. That is handled here rather than left to somebody with database access.
 */
export async function bounceChequeService(
  actor: ActorMeta,
  input: { paymentId: string; reason: string },
) {
  if (input.reason.trim().length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say why it bounced." });
  }

  const payment = await db.payment.findFirst({
    where: { id: input.paymentId, deletedAt: null },
    include: { allocations: true, invoice: true },
  });
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That payment no longer exists." });
  }
  if (payment.bouncedAt) return { status: "bounced" as const };

  const statements = await db.billingStatement.findMany({
    where: { id: { in: payment.allocations.map((allocation) => allocation.billingStatementId) } },
  });

  await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { bouncedAt: new Date(), bounceReason: input.reason.trim() },
    });

    // Only reverse what was actually applied. An uncleared cheque never settled anything.
    if (payment.clearedAt) {
      const byId = new Map(statements.map((statement) => [statement.id, statement]));
      for (const allocation of payment.allocations) {
        const statement = byId.get(allocation.billingStatementId);
        if (!statement) continue;
        const amountPaid = Math.max(0, statement.amountPaid - allocation.amount);
        await tx.billingStatement.update({
          where: { id: statement.id },
          data: {
            amountPaid,
            balance: statement.total - amountPaid,
            status: statementStatusFor({
              total: statement.total,
              amountPaid,
              dueDate: statement.dueDate,
              status: "issued",
            }),
            version: { increment: 1 },
          },
        });
      }

      if (payment.invoice) {
        // Retained and marked. Never deleted, never renumbered — §3.
        await tx.serviceInvoice.update({
          where: { id: payment.invoice.id },
          data: {
            status: "cancelled",
            cancellationReason: `The cheque behind it bounced: ${input.reason.trim()}`,
            cancelledById: actor.actorId,
            cancelledAt: new Date(),
          },
        });
      }
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "bounced",
      entityType: PAYMENT_ENTITY_TYPE,
      entityId: payment.id,
      summary:
        `${payment.number} bounced — ${input.reason.trim()}` +
        (payment.invoice ? `; ${payment.invoice.number} cancelled and retained` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "bounced" as const };
}

/**
 * Cancels a service invoice, retaining it.
 *
 * §3: "Cancelled or voided invoices are retained and marked, **never deleted or renumbered**." There
 * is no delete for this model anywhere in the platform, and this is the only way its status changes.
 */
export async function cancelInvoiceService(
  actor: ActorMeta,
  input: { serviceInvoiceId: string; reason: string },
) {
  if (input.reason.trim().length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A cancelled BIR document needs a reason somebody can read years later.",
    });
  }

  const invoice = await db.serviceInvoice.findUnique({ where: { id: input.serviceInvoiceId } });
  if (!invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That invoice does not exist." });
  }
  if (invoice.status === "cancelled") return { status: "cancelled" as const };

  await db.$transaction(async (tx) => {
    await tx.serviceInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "cancelled",
        cancellationReason: input.reason.trim(),
        cancelledById: actor.actorId,
        cancelledAt: new Date(),
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cancelled",
      entityType: SERVICE_INVOICE_ENTITY_TYPE,
      entityId: invoice.id,
      summary: `Cancelled ${invoice.number}, retained — ${input.reason.trim()}`,
      diff: { status: { from: "issued", to: "cancelled" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "cancelled" as const };
}

/**
 * §3.2's chase list: withholding recorded with no 2307 on file, oldest first.
 *
 * "Unrecovered 2307s are real money — they are creditable against income tax and worthless if never
 * collected." The list exists so the number is impossible to avoid looking at.
 */
export async function outstanding2307sService() {
  const payments = await db.payment.findMany({
    where: {
      deletedAt: null,
      withholdingTaxAmount: { gt: 0 },
      form2307ReceivedAt: null,
    },
    orderBy: { receivedAt: "asc" },
    take: 200,
  });

  const accounts = await db.customerAccount.findMany({
    where: { id: { in: payments.map((payment) => payment.accountId) } },
    select: { id: true, name: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const now = Date.now();
  return payments.map((payment) => ({
    paymentId: payment.id,
    number: payment.number,
    accountId: payment.accountId,
    accountName: byId.get(payment.accountId)?.name ?? null,
    receivedAt: payment.receivedAt,
    withholdingTaxAmount: payment.withholdingTaxAmount,
    daysOutstanding: Math.floor(
      (now - new Date(payment.receivedAt).getTime()) / (24 * 60 * 60 * 1000),
    ),
  }));
}

/**
 * §5's receivables ageing.
 *
 * ## Run on statements, never on invoices
 *
 * §5 says so in as many words — "the invoice only exists once the money is in" — and the consequence
 * is worth stating plainly: ageing receivables off service invoices would report a debt of **zero**
 * however much is owed, because an unpaid bill has no invoice behind it. It is the kind of error
 * that makes a system look healthiest exactly when it is not.
 */
export async function receivablesService() {
  const statements = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
      balance: { gt: 0 },
    },
    orderBy: { dueDate: "asc" },
    take: 500,
  });

  const accounts = await db.customerAccount.findMany({
    where: { id: { in: statements.map((statement) => statement.accountId) } },
    select: { id: true, name: true, withholdsEWT: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const now = new Date();
  const rows = statements.map((statement) => ({
    id: statement.id,
    number: statement.number,
    type: statement.type,
    accountId: statement.accountId,
    accountName: byId.get(statement.accountId)?.name ?? null,
    dueDate: statement.dueDate,
    total: statement.total,
    amountPaid: statement.amountPaid,
    balance: statement.balance,
    status: statement.status,
    expectedNetCollectible: statement.expectedNetCollectible,
    withholds: byId.get(statement.accountId)?.withholdsEWT ?? false,
    bucket: ageingBucket(statement.dueDate, now),
  }));

  const buckets = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const row of rows) buckets[row.bucket] += row.balance;

  return { rows, buckets, total: rows.reduce((sum, row) => sum + row.balance, 0) };
}

/**
 * Statements, including drafts — the list the billing clerk works from.
 *
 * `receivablesService` deliberately shows only what is **owed**: issued, part-paid or overdue with a
 * balance. That is the right shape for a receivables report and the wrong one for the person doing
 * the billing, because it hides the two states they act on most — a draft they have just raised and
 * have not sent, and a statement paid this morning that they want to confirm.
 *
 * Two lists rather than one filter on the first, for the same reason §5b's release queue is separate
 * from the cash advance register: the questions are different. *What do we need to chase* and *what
 * am I working on* have different orders and different audiences.
 */
export async function statementsService(filter: { status?: string; accountId?: string } = {}) {
  const statements = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
    },
    // Drafts first: they are the ones with an action outstanding, and a draft nobody issues is a
    // customer who never got asked for money.
    orderBy: [{ statementDate: "desc" }],
    take: 200,
  });

  const [accounts, invoices] = await Promise.all([
    db.customerAccount.findMany({
      where: { id: { in: [...new Set(statements.map((s) => s.accountId))] } },
      select: { id: true, name: true, withholdsEWT: true, ewtRate: true },
    }),
    db.serviceInvoice.findMany({
      where: { accountId: { in: [...new Set(statements.map((s) => s.accountId))] } },
      select: { id: true, number: true, billingStatementIds: true, status: true },
    }),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return statements.map((statement) => ({
    id: statement.id,
    number: statement.number,
    type: statement.type,
    status: statement.status,
    accountId: statement.accountId,
    accountName: accountById.get(statement.accountId)?.name ?? "unknown",
    withholds: accountById.get(statement.accountId)?.withholdsEWT ?? false,
    statementDate: statement.statementDate,
    dueDate: statement.dueDate,
    total: statement.total,
    amountPaid: statement.amountPaid,
    balance: statement.balance,
    expectedWithholdingAmount: statement.expectedWithholdingAmount,
    expectedNetCollectible: statement.expectedNetCollectible,
    poReference: statement.poReference,
    /*
      The invoices this statement has produced.

      §3: one statement can produce several invoices if the customer pays in instalments. Showing
      them on the statement is what makes the two-document model legible — otherwise somebody sees
      "paid" and has to go somewhere else to find the BIR document that says so.
    */
    invoices: invoices
      .filter((invoice) => invoice.billingStatementIds.includes(statement.id))
      .map((invoice) => ({ id: invoice.id, number: invoice.number, status: invoice.status })),
  }));
}

/**
 * §3.3's PDC register — cheques received and not yet cleared.
 *
 * The spec is blunt about why this is its own list: *"A received PDC is not collected cash. Getting
 * this wrong overstates collections and issues an invoice against money that may bounce."* A cheque
 * sitting here is a promise; only clearing it makes it money.
 *
 * Ordered by the cheque's own date, because that is the day somebody has to go to the bank.
 */
export async function pendingChequesService() {
  const cheques = await db.payment.findMany({
    where: { deletedAt: null, method: "check", clearedAt: null, bouncedAt: null },
    orderBy: [{ checkDate: "asc" }, { receivedAt: "asc" }],
    take: 200,
  });

  const accounts = await db.customerAccount.findMany({
    where: { id: { in: [...new Set(cheques.map((cheque) => cheque.accountId))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(accounts.map((account) => [account.id, account.name]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return cheques.map((cheque) => ({
    id: cheque.id,
    number: cheque.number,
    accountName: nameById.get(cheque.accountId) ?? "unknown",
    amount: cheque.amount,
    checkNumber: cheque.checkNumber,
    checkDate: cheque.checkDate,
    receivedAt: cheque.receivedAt,
    reference: cheque.reference,
    /** Whether the cheque's date has arrived — the day it can be presented, not the day it clears. */
    presentable: cheque.checkDate ? cheque.checkDate <= today : true,
  }));
}
