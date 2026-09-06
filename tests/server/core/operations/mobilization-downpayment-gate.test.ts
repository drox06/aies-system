import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  overrideMobilizationDownpaymentGateService,
  planMobilizationService,
  readinessForTicketService,
  updateMobilizationService,
} from "@/server/core/operations/mobilization-service";
import { recordExternalMethodologyService } from "@/server/core/operations/methodology-service";
import { METHODOLOGY_ENTITY_TYPE } from "@/server/core/operations/methodology-rules";
import { markMaterialsNotApplicableService } from "@/server/core/operations/material-request-service";
import { generateTicketsService } from "@/server/core/operations/ticket-service";
import type { ActorMeta } from "@/server/core/crm/account-service";

/**
 * docs/DECISIONS.md #186 — module 03's downpayment gate, reaching mobilisation for the first time.
 *
 * What only a real run settles:
 *
 *  1. **A ticket with no sales order is exempt**, not merely passing — `mobilization.test.ts`'s whole
 *     fixture is standalone tickets, and every one of those tests must keep passing unchanged. That
 *     file is not touched here; this one proves the *other* half, a ticket that does carry a sales
 *     order.
 *  2. **The gate reads live.** Money arriving after mobilisation was checked once must be reflected
 *     the next time it is checked, not cached from the ticket's creation.
 *  3. **The override is its own permission, scoped to this ticket**, and — like the cash advance and
 *     methodology overrides before it — actually opens the check, not merely moves a status column
 *     the gate function still contradicts.
 */

const suffix = randomUUID().slice(0, 8);
const actor: ActorMeta = { actorId: `dp-gate-${suffix}`, actorLabel: "Verification actor" };

const accountIds: string[] = [];
const siteIds: string[] = [];
const contactIds: string[] = [];
const quotationIds: string[] = [];
const poIds: string[] = [];
const fileIds: string[] = [];
const orderIds: string[] = [];
const ticketIds: string[] = [];
const projectIds: string[] = [];
const mobilizationIds: string[] = [];

/** A real order, with a downpayment agreed but not yet paid, and one execution line. */
async function makeOrderAwaitingDownpayment() {
  const account = await db.customerAccount.create({
    data: {
      code: `DPG-${randomUUID().slice(0, 12)}`,
      name: `Downpayment Gate Co ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const contact = await db.contact.create({
    data: {
      accountId: account.id,
      firstName: "Plant",
      lastName: `Engineer ${suffix}`,
      phone: "0917",
    },
  });
  contactIds.push(contact.id);

  const site = await db.site.create({
    data: { accountId: account.id, name: `Plant ${suffix}`, contactId: contact.id },
  });
  siteIds.push(site.id);

  const quotation = await db.quotation.create({
    data: {
      number: `TEST-LQ-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      title: "Downpayment gate fixture",
      scopeOfWork: "Installation work the crew must not start before payment.",
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preparedById: actor.actorId,
      total: "50000.00",
      subtotal: "50000.00",
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
      amount: "50000.00",
      fileId: file.id,
      receivedById: actor.actorId,
    },
  });
  poIds.push(po.id);

  const order = await db.salesOrder.create({
    data: {
      number: `TEST-SO-${randomUUID().slice(0, 10)}`,
      accountId: account.id,
      siteId: site.id,
      quotationId: quotation.id,
      customerPOId: po.id,
      ownerId: actor.actorId,
      status: "open",
      currency: "PHP",
      subtotal: "50000.00",
      total: "50000.00",
      // The default is already "awaiting_downpayment", written explicitly so the fixture reads as
      // the fact it is testing rather than an accident of the schema's default.
      financeStatus: "awaiting_downpayment",
      downpaymentPct: "30",
      downpaymentAmount: 1_500_000,
    },
  });
  orderIds.push(order.id);

  await db.salesOrderLine.create({
    data: {
      salesOrderId: order.id,
      lineNo: 1,
      description: "Installation and commissioning",
      itemType: "service",
      requiresExecution: true,
    },
  });

  return { order, account };
}

/** Everything else §8 wants, so the downpayment gate is the only thing standing in the way. */
async function clearEveryOtherGate(ticketId: string) {
  await markMaterialsNotApplicableService(actor, { ticketId });

  const file = await db.fileObject.create({
    data: {
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: ticketId,
      filename: "client-permit-to-work.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: randomUUID(),
      storageKey: `test/${randomUUID()}.pdf`,
      uploaderId: actor.actorId,
    },
  });
  fileIds.push(file.id);

  await recordExternalMethodologyService(actor, {
    ticketId,
    title: "Client's permit to work",
    scopeSummary: "Attend and fit, to the plant's own form.",
    approvalFileId: file.id,
    clientApprovedByName: "Plant Engineer",
    clientApprovedAt: new Date(Date.now() - 60_000),
  });

  // Crew, PPE, gate pass and permits — the rest of §8's list, so downpayment is the only thing
  // left standing between this ticket and "ready to mobilise".
  const mobilization = await planMobilizationService(actor, {
    ticketId,
    type: "mobilization",
    crewIds: [actor.actorId],
  });
  mobilizationIds.push(mobilization.id);
  await updateMobilizationService(actor, {
    mobilizationId: mobilization.id,
    gatePassStatus: "not_required",
    permitStatus: "not_required",
    inductionCompleted: true,
    ppeChecklist: [{ label: "Harness", checked: true }],
  });
}

afterAll(async () => {
  await db.materialRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.mobilization.deleteMany({ where: { id: { in: mobilizationIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...ticketIds, ...orderIds, ...accountIds, ...mobilizationIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: actor.actorId } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.site.deleteMany({ where: { id: { in: siteIds } } });
  await db.contact.deleteMany({ where: { id: { in: contactIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the downpayment gate reaching mobilisation", () => {
  it("blocks a ticket on a real order awaiting its downpayment, and clears once it arrives", async () => {
    const { order } = await makeOrderAwaitingDownpayment();
    const generated = await generateTicketsService(actor, {
      salesOrderId: order.id,
      tickets: [
        {
          type: "installation",
          title: "Installation",
          scopeOfWork: "Install and commission the unit.",
          salesOrderLineIds: (
            await db.salesOrderLine.findMany({ where: { salesOrderId: order.id } })
          ).map((line) => line.id),
        },
      ],
    });
    const ticket = generated.tickets[0]!;
    ticketIds.push(ticket.id);
    if (generated.project) projectIds.push(generated.project.id);

    await clearEveryOtherGate(ticket.id);

    const blocked = await readinessForTicketService(ticket.id);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.map((b) => b.key)).toContain("downpayment");
    expect(blocked.items.find((i) => i.key === "downpayment")!.detail).toMatch(/30%/);

    // The money arrives — read live, not from whatever the ticket saw at creation.
    await db.salesOrder.update({
      where: { id: order.id },
      data: { financeStatus: "downpayment_received" },
    });

    const opened = await readinessForTicketService(ticket.id);
    expect(opened.ready).toBe(true);
    expect(opened.items.find((i) => i.key === "downpayment")!.state).toBe("pass");
  }, 30000);

  it("exempts a ticket with no sales order behind it", async () => {
    // The existing standalone-ticket fixtures in mobilization.test.ts already prove this
    // implicitly by continuing to pass; this makes the exemption an explicit, named claim.
    const { account } = await makeOrderAwaitingDownpayment();
    const standaloneTicket = await db.ticket.create({
      data: {
        number: `TEST-TKT-${randomUUID().slice(0, 10)}`,
        type: "after_sales",
        title: "Warranty callback",
        scopeOfWork: "No PO behind this one.",
        raisedById: actor.actorId,
        accountId: account.id,
        status: "generated",
        priority: "normal",
      },
    });
    ticketIds.push(standaloneTicket.id);

    const readiness = await readinessForTicketService(standaloneTicket.id);
    expect(readiness.items.find((i) => i.key === "downpayment")!.state).toBe("pass");
    expect(readiness.items.find((i) => i.key === "downpayment")!.detail).toMatch(/no sales order/i);
  });

  it("lets the new override actually open the check, and refuses one with no gate to open", async () => {
    const { order } = await makeOrderAwaitingDownpayment();
    const generated = await generateTicketsService(actor, {
      salesOrderId: order.id,
      tickets: [
        {
          type: "installation",
          title: "Installation",
          scopeOfWork: "Install and commission the unit.",
          salesOrderLineIds: (
            await db.salesOrderLine.findMany({ where: { salesOrderId: order.id } })
          ).map((line) => line.id),
        },
      ],
    });
    const ticket = generated.tickets[0]!;
    ticketIds.push(ticket.id);
    if (generated.project) projectIds.push(generated.project.id);
    await clearEveryOtherGate(ticket.id);

    await expect(
      overrideMobilizationDownpaymentGateService(actor, { ticketId: ticket.id, reason: "short" }),
    ).rejects.toThrow(/reason somebody can read/);

    await overrideMobilizationDownpaymentGateService(actor, {
      ticketId: ticket.id,
      reason: "Long-standing client; VP approved sending the crew ahead by phone.",
    });

    const opened = await readinessForTicketService(ticket.id);
    expect(opened.ready).toBe(true);
    const item = opened.items.find((i) => i.key === "downpayment")!;
    expect(item.state).toBe("pass");
    expect(item.detail).toMatch(/Long-standing client/);

    // The override does not touch `financeStatus` — it only lets this one ticket past a gate
    // that still, honestly, says the money has not arrived. Once it actually does, there is
    // nothing left to override.
    await db.salesOrder.update({
      where: { id: order.id },
      data: { financeStatus: "downpayment_received" },
    });
    await expect(
      overrideMobilizationDownpaymentGateService(actor, {
        ticketId: ticket.id,
        reason: "Trying again for no reason.",
      }),
    ).rejects.toThrow(/nothing to override/);
  }, 30000);
});
