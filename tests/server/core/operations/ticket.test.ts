import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createStandaloneTicketService,
  generateTicketsService,
  getTicketService,
  listTicketsService,
  proposeTicketsForSalesOrderService,
} from "@/server/core/operations/ticket-service";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import {
  createSalesOrderFromPoService,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";

/**
 * specs/04-operations-projects.md §4, against the real database.
 *
 * §20's first case: "Ticket generation from a mixed sales order proposes the correct type set;
 * **operations edits are respected**; each ticket links the right sales order lines." The edits
 * clause is the one that matters here — the proposal is a suggestion, and what gets created is
 * whatever the reviewer confirmed, including things the proposal never suggested.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `tkt-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "DJ (operations)" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const customerPoIds: string[] = [];
const salesOrderIds: string[] = [];
const ticketIds: string[] = [];
const projectIds: string[] = [];
const fileIds: string[] = [];

const dispatcher = {
  id: OWNER,
  email: "dj@aies.local",
  name: "DJ",
  roleKeys: ["operations_manager"],
  permissions: new Set([
    "ticket.view",
    "ticket.view_all",
    "project.view_cost",
  ]) as ReadonlySet<string>,
};

/** A technician: §19 scopes them to tickets they are assigned to. */
const technician = {
  id: `${OWNER}-tech`,
  email: "tech@aies.local",
  name: "Tech",
  roleKeys: ["technician"],
  permissions: new Set(["ticket.view"]) as ReadonlySet<string>,
};

/** A sales order with two goods lines and one service line — §20's "mixed sales order". */
async function makeMixedSalesOrder() {
  const account = await db.customerAccount.create({
    data: { code: `TKT-${randomUUID().slice(0, 12)}`, name: `TKT Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: `Supply and install ${randomUUID().slice(0, 6)}`,
  });
  quotationIds.push(quotation.id);
  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      {
        itemType: "product",
        description: "Flow meter DN150",
        quantity: "2",
        unitCost: "1000",
        markupPct: "20",
      },
      {
        itemType: "product",
        description: "Gaskets",
        quantity: "4",
        unitCost: "50",
        markupPct: "20",
      },
      {
        itemType: "service",
        description: "Commissioning",
        quantity: "1",
        unitCost: "5000",
        markupPct: "20",
      },
    ],
  });
  const saved = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

  const file = await db.fileObject.create({
    data: {
      entityType: "CustomerPO",
      entityId: quotation.id,
      storageKey: `CustomerPO/${randomUUID()}-po.pdf`,
      filename: "po.pdf",
      mimeType: "application/pdf",
      size: 10,
      sha256: randomUUID().replace(/-/g, ""),
      uploaderId: OWNER,
    },
  });
  fileIds.push(file.id);

  const customerPo = await db.customerPO.create({
    data: {
      accountId: account.id,
      quotationId: quotation.id,
      poNumber: `PO-${randomUUID().slice(0, 8)}`,
      poDate: new Date(),
      amount: saved.total.toString(),
      currency: saved.currency,
      fileId: file.id,
      receivedById: OWNER,
      receivedAt: new Date(),
    },
  });
  customerPoIds.push(customerPo.id);

  await verifyCustomerPoService(actor, { customerPOId: customerPo.id });
  const order = await createSalesOrderFromPoService(actor, { customerPOId: customerPo.id });
  salesOrderIds.push(order.id);
  return { order, account };
}

/** Records what was created for `afterAll`, and hands the result straight back for assertions. */
function track<T extends { project: { id: string } | null; tickets: { id: string }[] }>(
  result: T,
): T {
  if (result.project) projectIds.push(result.project.id);
  result.tickets.forEach((ticket) => ticketIds.push(ticket.id));
  return result;
}

afterAll(async () => {
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [
          ...ticketIds,
          ...projectIds,
          ...salesOrderIds,
          ...quotationIds,
          ...accountIds,
          ...customerPoIds,
        ],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: salesOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: customerPoIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("§4: the proposal is a proposal", () => {
  it("proposes an installation and a delivery from a mixed order, and creates nothing", async () => {
    const { order } = await makeMixedSalesOrder();

    const proposal = await proposeTicketsForSalesOrderService(order.id);
    expect(proposal.proposed.map((t) => t.type)).toEqual(["installation", "delivery"]);

    // The whole point of §4: nothing exists yet.
    const tickets = await db.ticket.count({ where: { salesOrderId: order.id } });
    expect(tickets).toBe(0);
  }, 60_000);

  it("nothing generates tickets from sales_order.created", async () => {
    // §4: "Do not auto-generate silently." The event fires when the order is raised; no subscriber
    // acts on it, and this is the assertion that keeps it that way.
    const { order } = await makeMixedSalesOrder();
    const tickets = await db.ticket.count({ where: { salesOrderId: order.id } });
    expect(tickets).toBe(0);
  }, 60_000);
});

describe("§20: operations edits are respected", () => {
  it("creates exactly what was confirmed, not what was proposed", async () => {
    const { order } = await makeMixedSalesOrder();
    const proposal = await proposeTicketsForSalesOrderService(order.id);
    const execution = proposal.proposed.find((t) => t.type === "installation")!;

    // The reviewer changes the type — the correction §4 anticipates — and drops the delivery.
    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "new_project",
            title: "Build the metering skid",
            scopeOfWork: "Fabricate and install.",
            salesOrderLineIds: execution.salesOrderLineIds,
          },
        ],
      }),
    );

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]!.type).toBe("new_project");
    expect(result.tickets[0]!.title).toBe("Build the metering skid");
  }, 60_000);

  it("links each ticket to the right sales order lines", async () => {
    const { order } = await makeMixedSalesOrder();
    const proposal = await proposeTicketsForSalesOrderService(order.id);

    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: proposal.proposed.map((ticket) => ({
          type: ticket.type,
          title: ticket.title,
          scopeOfWork: ticket.scopeOfWork,
          salesOrderLineIds: ticket.salesOrderLineIds,
        })),
      }),
    );

    const installation = result.tickets.find((t) => t.type === "installation")!;
    const delivery = result.tickets.find((t) => t.type === "delivery")!;
    const serviceLine = order.lines.find((line) => line.requiresExecution)!;

    const installationLines = await db.ticketSalesOrderLine.findMany({
      where: { ticketId: installation.id },
    });
    expect(installationLines.map((l) => l.salesOrderLineId)).toEqual([serviceLine.id]);

    const deliveryLines = await db.ticketSalesOrderLine.findMany({
      where: { ticketId: delivery.id },
    });
    expect(deliveryLines).toHaveLength(2);
  }, 60_000);

  it("refuses a line that belongs to another order", async () => {
    const { order } = await makeMixedSalesOrder();
    const other = await makeMixedSalesOrder();

    await expect(
      generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "delivery",
            title: "Wrong lines",
            scopeOfWork: "x",
            salesOrderLineIds: [other.order.lines[0]!.id],
          },
        ],
      }),
    ).rejects.toThrow(/does not belong to/);
  }, 90_000);

  it("refuses to cover a line a live ticket already covers", async () => {
    // Two tickets claiming one line would bill it twice — §4 wants the link accurate "so
    // fulfilment counters and billing milestones stay accurate".
    const { order } = await makeMixedSalesOrder();
    const lineId = order.lines[0]!.id;

    track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          { type: "delivery", title: "First", scopeOfWork: "x", salesOrderLineIds: [lineId] },
        ],
      }),
    );

    await expect(
      generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          { type: "delivery", title: "Second", scopeOfWork: "x", salesOrderLineIds: [lineId] },
        ],
      }),
    ).rejects.toThrow(/already covered by/);
  }, 60_000);

  it("proposes only the remainder when opened again", async () => {
    const { order } = await makeMixedSalesOrder();
    const first = await proposeTicketsForSalesOrderService(order.id);
    const execution = first.proposed.find((t) => t.type === "installation")!;

    track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "installation",
            title: execution.title,
            scopeOfWork: execution.scopeOfWork,
            salesOrderLineIds: execution.salesOrderLineIds,
          },
        ],
      }),
    );

    const second = await proposeTicketsForSalesOrderService(order.id);
    // The installation is covered, so only the goods remain.
    expect(second.proposed.map((t) => t.type)).toEqual(["delivery"]);
    expect(second.existingTickets).toHaveLength(1);
  }, 60_000);
});

describe("§2: the project, and the lane that has none", () => {
  it("puts execution tickets on one project and leaves delivery off it", async () => {
    const { order } = await makeMixedSalesOrder();
    const proposal = await proposeTicketsForSalesOrderService(order.id);

    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: proposal.proposed.map((ticket) => ({
          type: ticket.type,
          title: ticket.title,
          scopeOfWork: ticket.scopeOfWork,
          salesOrderLineIds: ticket.salesOrderLineIds,
        })),
      }),
    );

    expect(result.project).not.toBeNull();
    expect(result.project!.code).toMatch(/^AIESPRJ-\d{6}$/);

    const installation = result.tickets.find((t) => t.type === "installation")!;
    const delivery = result.tickets.find((t) => t.type === "delivery")!;
    expect(installation.projectId).toBe(result.project!.id);
    // §1: the delivery lane "is not a step inside a project — it is a ticket type".
    expect(delivery.projectId).toBeNull();
  }, 60_000);

  it("creates no project for a delivery-only generation", async () => {
    const { order } = await makeMixedSalesOrder();
    const goodsLines = order.lines.filter((line) => !line.requiresExecution).map((l) => l.id);

    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          { type: "delivery", title: "Deliver", scopeOfWork: "x", salesOrderLineIds: goodsLines },
        ],
      }),
    );

    expect(result.project).toBeNull();
  }, 60_000);

  it("moves the sales order's execution workstream, and only that one", async () => {
    const { order } = await makeMixedSalesOrder();
    const execLines = order.lines.filter((line) => line.requiresExecution).map((l) => l.id);

    track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "installation",
            title: "Install",
            scopeOfWork: "x",
            salesOrderLineIds: execLines,
          },
        ],
      }),
    );

    const after = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.executionStatus).toBe("pending");
    // §1's other workstreams are module 03's and untouched.
    expect(after.financeStatus).toBe(order.financeStatus);
    expect(after.procurementStatus).toBe(order.procurementStatus);
  }, 60_000);

  it("emits ticket.generated with the lines each ticket covers", async () => {
    const { order } = await makeMixedSalesOrder();
    const proposal = await proposeTicketsForSalesOrderService(order.id);
    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: proposal.proposed.map((ticket) => ({
          type: ticket.type,
          title: ticket.title,
          scopeOfWork: ticket.scopeOfWork,
          salesOrderLineIds: ticket.salesOrderLineIds,
        })),
      }),
    );

    const event = await db.eventOutbox.findFirstOrThrow({
      where: { event: "ticket.generated", payload: { path: ["salesOrderId"], equals: order.id } },
    });
    const payload = event.payload as {
      tickets: { ticketId: string; salesOrderLineIds: string[] }[];
    };
    expect(payload.tickets).toHaveLength(result.tickets.length);
    expect(payload.tickets.every((t) => t.salesOrderLineIds.length > 0)).toBe(true);
  }, 60_000);
});

describe("§4's standalone ticket", () => {
  it("is not billable by default and demands a justification", async () => {
    const account = await db.customerAccount.create({
      data: {
        code: `TKT-${randomUUID().slice(0, 12)}`,
        name: `Standalone ${suffix}`,
        ownerId: OWNER,
      },
    });
    accountIds.push(account.id);

    await expect(
      createStandaloneTicketService(actor, {
        accountId: account.id,
        type: "after_sales",
        title: "Goodwill visit",
        scopeOfWork: "Look at the meter that keeps alarming.",
        justification: "",
      }),
    ).rejects.toThrow(/Say why this ticket exists/);

    const ticket = await createStandaloneTicketService(actor, {
      accountId: account.id,
      type: "after_sales",
      subType: "warranty",
      title: "Goodwill visit",
      scopeOfWork: "Look at the meter that keeps alarming.",
      justification: "Customer of eight years; the fault is borderline in-warranty.",
    });
    ticketIds.push(ticket.id);

    expect(ticket.billable).toBe(false);
    expect(ticket.salesOrderId).toBeNull();
    expect(ticket.number).toMatch(/^AIESTKT-\d{6}$/);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityType: TICKET_ENTITY_TYPE, entityId: ticket.id },
    });
    expect(audit.summary).toContain("not billable");
    expect(audit.summary).toContain("Customer of eight years");
  }, 60_000);
});

describe("§19's scoping and cost gating", () => {
  it("hides a ticket from a technician who is not on it", async () => {
    const { order } = await makeMixedSalesOrder();
    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "delivery",
            title: "Deliver",
            scopeOfWork: "x",
            salesOrderLineIds: [order.lines[0]!.id],
          },
        ],
      }),
    );

    await expect(getTicketService(technician, result.tickets[0]!.id)).rejects.toThrow(
      /no longer exists/,
    );
    const theirs = await listTicketsService(technician, {});
    expect(theirs.map((t) => t.id)).not.toContain(result.tickets[0]!.id);
  }, 60_000);

  it("shows it once they are assigned", async () => {
    const { order } = await makeMixedSalesOrder();
    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "installation",
            title: "Install",
            scopeOfWork: "x",
            salesOrderLineIds: order.lines.filter((l) => l.requiresExecution).map((l) => l.id),
            assignedLeadId: technician.id,
          },
        ],
      }),
    );

    const seen = await getTicketService(technician, result.tickets[0]!.id);
    expect(seen.id).toBe(result.tickets[0]!.id);
  }, 60_000);

  it("never shows a technician the contract value", async () => {
    // §19: technicians "see scope, site data, and their own cash advances — never contract value
    // or margin".
    const { order } = await makeMixedSalesOrder();
    const result = track(
      await generateTicketsService(actor, {
        salesOrderId: order.id,
        tickets: [
          {
            type: "installation",
            title: "Install",
            scopeOfWork: "x",
            salesOrderLineIds: order.lines.filter((l) => l.requiresExecution).map((l) => l.id),
            assignedLeadId: technician.id,
          },
        ],
      }),
    );

    const asTechnician = await getTicketService(technician, result.tickets[0]!.id);
    expect(asTechnician.project?.contractValue).toBeNull();
    expect(asTechnician.project?.budgetCost).toBeNull();
    // The scope and the site are exactly what they do get.
    expect(asTechnician.scopeOfWork).toBe("x");

    const asDispatcher = await getTicketService(dispatcher, result.tickets[0]!.id);
    expect(asDispatcher.project?.contractValue).not.toBeNull();
  }, 60_000);
});
