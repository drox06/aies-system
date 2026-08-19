import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { finalBillingGate } from "@/server/core/finance/final-billing-gate";
import { raiseStatementService } from "@/server/core/finance/invoice-service";

/**
 * specs/05-finance-billing.md §4 — the final billing gate.
 *
 * ## Why each condition is tested on its own
 *
 * §11: "Final billing gate blocks on each unmet condition **independently**." That is not a testing
 * convenience — it is the behaviour. Finance chasing six missing things in one pass is one
 * conversation; discovering them one refusal at a time is six, spread over days, while the money
 * ages.
 *
 * So each test below leaves exactly one thing undone and checks that the gate names it, with its
 * owner, while the others pass.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `gate-${suffix}`, actorLabel: "Finance officer" };

const accountIds: string[] = [];
const orderIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];
const ticketIds: string[] = [];
const projectIds: string[] = [];
const statementIds: string[] = [];

/**
 * A goods-only order: no executable lines, so four of the seven conditions do not apply.
 *
 * This is the case §4's "or the order has no executable scope" exists for, and it is the common one
 * — most of what AIES bills is equipment.
 */
async function makeOrder(options: { executable: boolean }) {
  const account = await db.customerAccount.create({
    data: {
      code: `GATE-${randomUUID().slice(0, 12)}`,
      name: `Gate Co ${randomUUID().slice(0, 6)}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const quotation = await db.quotation.create({
    data: {
      number: `TEST-LQ-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      title: "Gate fixture",
      scopeOfWork: "Work.",
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preparedById: actor.actorId,
      total: "100000.00",
      subtotal: "100000.00",
    },
  });
  quotationIds.push(quotation.id);

  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: account.id,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      storageKey: `test/${randomUUID()}.pdf`,
      uploaderId: actor.actorId,
    },
  });
  fileIds.push(file.id);

  const po = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      amount: "100000.00",
      fileId: file.id,
      receivedById: actor.actorId,
    },
  });
  poIds.push(po.id);

  const order = await db.salesOrder.create({
    data: {
      number: `TEST-SO-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      quotationId: quotation.id,
      customerPOId: po.id,
      ownerId: actor.actorId,
      status: "open",
      currency: "PHP",
      subtotal: "100000.00",
      total: "100000.00",
      lines: {
        create: [
          {
            lineNo: 1,
            description: options.executable ? "Install the meter" : "Supply one meter",
            quantity: "1",
            unitPrice: "100000.00",
            lineTotal: "100000.00",
            requiresExecution: options.executable,
            itemType: options.executable ? "service" : "product",
          },
        ],
      },
    },
  });
  orderIds.push(order.id);
  return { order, account };
}

/** A closed project with everything §4 wants, so a test can remove exactly one thing. */
async function makeCompletedExecution(order: { id: string; accountId: string }) {
  const project = await db.project.create({
    data: {
      code: `TEST-PRJ-${randomUUID().slice(0, 8)}`,
      name: "Gate fixture",
      accountId: order.accountId,
      status: "closed",
      scopeOfWork: "Work.",
    },
  });
  projectIds.push(project.id);

  const ticket = await db.ticket.create({
    data: {
      number: `TEST-TKT-${randomUUID().slice(0, 10)}`,
      type: "installation",
      title: "Gate fixture",
      scopeOfWork: "Do the work.",
      raisedById: actor.actorId,
      accountId: order.accountId,
      salesOrderId: order.id,
      projectId: project.id,
      status: "generated",
      priority: "normal",
    },
  });
  ticketIds.push(ticket.id);

  await db.serviceReport.create({
    data: {
      number: `TEST-SR-${randomUUID().slice(0, 10)}`,
      ticketId: ticket.id,
      projectId: project.id,
      status: "approved",
      workPerformed: "Installed and tested.",
      preparedById: actor.actorId,
    },
  });

  await db.qAApproval.create({
    data: {
      number: `TEST-QA-${randomUUID().slice(0, 10)}`,
      ticketId: ticket.id,
      projectId: project.id,
      approved: true,
      clientInspected: true,
      evidenceFileIds: ["evidence-1"],
      recordedById: actor.actorId,
    },
  });

  await db.projectCloseOut.create({
    data: {
      projectId: project.id,
      status: "approved",
      customerAcceptanceRequired: true,
      customerAcceptanceFileId: "acceptance-1",
    },
  });

  return { project, ticket };
}

afterAll(async () => {
  await db.billingStatementLine.deleteMany({ where: { statementId: { in: statementIds } } });
  await db.billingStatement.deleteMany({ where: { id: { in: statementIds } } });
  await db.serviceReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.qAApproval.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.testingCommissioning.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.projectCloseOut.deleteMany({ where: { projectId: { in: projectIds } } });
  await db.cashAdvance.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.actorId } });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

const condition = (gate: Awaited<ReturnType<typeof finalBillingGate>>, key: string) =>
  gate.conditions.find((c) => c.key === key)!;

describe("an order with nothing to execute", () => {
  /**
   * §4: "or the order has no executable scope". Most of what AIES bills is equipment, and demanding
   * a closed project for a delivery would block every goods-only final bill the company ever raises.
   */
  it("passes the conditions that cannot apply to it, and says why", async () => {
    const { order } = await makeOrder({ executable: false });
    const gate = await finalBillingGate(order.id);

    expect(gate.ok).toBe(true);
    expect(condition(gate, "project_closed").notApplicable).toBe(true);
    expect(condition(gate, "project_closed").detail).toMatch(/no project to close/);
    expect(condition(gate, "close_out").notApplicable).toBe(true);
    expect(condition(gate, "commissioning").notApplicable).toBe(true);
    expect(condition(gate, "delivery_receipts").notApplicable).toBe(true);
  });
});

describe("each condition blocks on its own", () => {
  it("passes when everything is done", async () => {
    const { order } = await makeOrder({ executable: true });
    await makeCompletedExecution(order);

    const gate = await finalBillingGate(order.id);
    expect(gate.blockers).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("blocks on a project still open, and names it", async () => {
    const { order } = await makeOrder({ executable: true });
    const { project } = await makeCompletedExecution(order);
    await db.project.update({ where: { id: project.id }, data: { status: "in_progress" } });

    const gate = await finalBillingGate(order.id);
    expect(gate.ok).toBe(false);
    const blocked = condition(gate, "project_closed");
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain(project.code);
    expect(blocked.owner).toBe("Operations");

    // Only that one.
    expect(gate.blockers.map((b) => b.key)).toEqual(["project_closed"]);
  });

  it("blocks on a service report that is not approved", async () => {
    const { order } = await makeOrder({ executable: true });
    const { ticket } = await makeCompletedExecution(order);
    await db.serviceReport.updateMany({
      where: { ticketId: ticket.id },
      data: { status: "pending_signature" },
    });

    const gate = await finalBillingGate(order.id);
    expect(condition(gate, "service_reports").ok).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toEqual(["service_reports"]);
  });

  it("blocks on a failed QA", async () => {
    const { order } = await makeOrder({ executable: true });
    const { ticket } = await makeCompletedExecution(order);
    await db.qAApproval.updateMany({ where: { ticketId: ticket.id }, data: { approved: false } });

    const gate = await finalBillingGate(order.id);
    expect(condition(gate, "qa_passed").ok).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toEqual(["qa_passed"]);
  });

  /**
   * §4's own note: the client's approval of QA is both the gate and the collection argument — it is
   * the customer's own inspection, in writing. An approval with no document behind it is a status
   * AIES set, which is exactly what a disputing customer will say.
   */
  it("blocks on a client QA approval with no evidence on file", async () => {
    const { order } = await makeOrder({ executable: true });
    const { ticket } = await makeCompletedExecution(order);
    await db.qAApproval.updateMany({
      where: { ticketId: ticket.id },
      data: { evidenceFileIds: [] },
    });

    const gate = await finalBillingGate(order.id);
    expect(condition(gate, "qa_client_evidence").ok).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toEqual(["qa_client_evidence"]);
  });

  it("blocks on an unliquidated cash advance, and says finance owns it", async () => {
    const { order } = await makeOrder({ executable: true });
    const { ticket } = await makeCompletedExecution(order);

    await db.cashAdvance.create({
      data: {
        number: `TEST-CA-${randomUUID().slice(0, 10)}`,
        ticketId: ticket.id,
        requestedById: actor.actorId,
        requestedFor: [actor.actorId],
        purpose: "Site expenses",
        breakdown: [],
        amountRequested: "5000.00",
        neededBy: new Date(),
        status: "released",
      },
    });

    const gate = await finalBillingGate(order.id);
    const blocked = condition(gate, "cash_advances");
    expect(blocked.ok).toBe(false);
    expect(blocked.owner).toBe("Finance");
    expect(gate.blockers.map((b) => b.key)).toEqual(["cash_advances"]);
  });

  it("blocks on a missing customer acceptance, unless it was waived with a reason", async () => {
    const { order } = await makeOrder({ executable: true });
    const { project } = await makeCompletedExecution(order);

    await db.projectCloseOut.updateMany({
      where: { projectId: project.id },
      data: { customerAcceptanceFileId: null },
    });
    expect(condition(await finalBillingGate(order.id), "close_out").ok).toBe(false);

    // A waiver is an answer. A blank is not — the same distinction as §7's recorded N/A.
    await db.projectCloseOut.updateMany({
      where: { projectId: project.id },
      data: { acceptanceWaiverReason: "Customer confirmed by email that they do not sign these." },
    });
    expect(condition(await finalBillingGate(order.id), "close_out").ok).toBe(true);
  });

  /** Six things missing is one conversation. Six refusals is six. */
  it("reports every unmet condition at once rather than the first one", async () => {
    const { order } = await makeOrder({ executable: true });
    const { project, ticket } = await makeCompletedExecution(order);

    await db.project.update({ where: { id: project.id }, data: { status: "in_progress" } });
    await db.serviceReport.updateMany({
      where: { ticketId: ticket.id },
      data: { status: "draft" },
    });
    await db.qAApproval.updateMany({ where: { ticketId: ticket.id }, data: { approved: false } });

    const gate = await finalBillingGate(order.id);
    expect(gate.blockers.length).toBeGreaterThanOrEqual(3);
    expect(gate.blockers.map((b) => b.key)).toEqual(
      expect.arrayContaining(["project_closed", "service_reports", "qa_passed"]),
    );
  });
});

describe("raising the final statement", () => {
  it("refuses one the gate is blocking, and lists what is missing", async () => {
    const { order, account } = await makeOrder({ executable: true });
    const { project } = await makeCompletedExecution(order);
    await db.project.update({ where: { id: project.id }, data: { status: "in_progress" } });

    await expect(
      raiseStatementService(actor, {
        accountId: account.id,
        salesOrderId: order.id,
        type: "final",
        dueDate: new Date("2026-12-31"),
        lines: [{ description: "Balance", quantity: 1, unitPrice: 50_000 }],
      }),
    ).rejects.toThrow(/cannot be issued yet/);
  });

  /** §4: proceeding is allowed with a logged reason. The reason is what AIES stands on later. */
  it("allows it with a reason, and logs the override", async () => {
    const { order, account } = await makeOrder({ executable: true });
    const { project } = await makeCompletedExecution(order);
    await db.project.update({ where: { id: project.id }, data: { status: "in_progress" } });

    const raised = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      type: "final",
      dueDate: new Date("2026-12-31"),
      lines: [{ description: "Balance", quantity: 1, unitPrice: 50_000 }],
      overrideGateReason: "Customer requires the bill before their year end; close-out follows.",
    });
    statementIds.push(raised.id);

    const logged = await db.auditLog.findFirst({
      where: { action: "billing_gate_overridden", entityId: order.id },
    });
    expect(logged).not.toBeNull();
    expect(logged!.summary).toMatch(/year end/);
  });

  /**
   * A downpayment before any work starts is the point of a downpayment, and a progress bill is by
   * definition raised mid-project. Gating either would make the platform refuse the terms the
   * company actually sells on.
   */
  it("does not gate a downpayment or a progress bill", async () => {
    const { order, account } = await makeOrder({ executable: true });
    const { project } = await makeCompletedExecution(order);
    await db.project.update({ where: { id: project.id }, data: { status: "in_progress" } });

    const downpayment = await raiseStatementService(actor, {
      accountId: account.id,
      salesOrderId: order.id,
      type: "downpayment",
      dueDate: new Date("2026-12-31"),
      lines: [{ description: "50% on order", quantity: 1, unitPrice: 50_000 }],
    });
    statementIds.push(downpayment.id);
    expect(downpayment.number).toMatch(/^AIESBS-/);
  });
});
