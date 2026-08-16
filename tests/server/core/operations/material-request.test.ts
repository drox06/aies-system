import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  adjustStockService,
  approveMaterialRequestService,
  createMaterialRequestService,
  getMaterialRequestService,
  issueMaterialsService,
  markMaterialsNotApplicableService,
  materialGateForTicket,
  outstandingCustodyService,
  returnMaterialsService,
  submitMaterialRequestService,
  upsertStockItemService,
} from "@/server/core/operations/material-request-service";
import { MATERIAL_REQUEST_ENTITY_TYPE } from "@/server/core/operations/material-request-rules";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import {
  createMethodologyService,
  saveMethodologyService,
} from "@/server/core/operations/methodology-service";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §7, against the real database.
 *
 * What cannot be proved by a pure function:
 *
 *  1. **The store's count actually moves**, and an issue that would take it negative is refused.
 *  2. **An out-of-calibration instrument is refused at the point of issue** — §7's one hard block.
 *  3. **N/A is a recorded decision**, with an audit row naming who made it.
 *  4. **The method statement's lists carry across**, so nobody types them twice (§6.2).
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const requestIds: string[] = [];
const stockIds: string[] = [];
const methodologyIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `mr-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
      name: `${roleKey} ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleKeys: [roleKey],
    permissions: new Set(permissions),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

async function makeTicket(lead: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `MR-${randomUUID().slice(0, 12)}`, name: `MR Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);
  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type: "installation",
    title: `Install ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Fit and commission.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

async function makeStock(
  storeman: AuthedUser,
  overrides: Partial<{ name: string; qtyOnHand: number; calibrationDueAt: Date | null }> = {},
) {
  const item = await upsertStockItemService(actorFor(storeman), {
    sku: `SKU-${randomUUID().slice(0, 10)}`,
    name: overrides.name ?? `Gasket set ${suffix}`,
    category: "consumable",
    unit: "pc",
    qtyOnHand: overrides.qtyOnHand ?? 10,
    calibrationDueAt: overrides.calibrationDueAt ?? null,
  });
  stockIds.push(item.id);
  return item;
}

async function approvedRequest(
  lead: AuthedUser,
  officer: AuthedUser,
  ticketId: string,
  lines: Parameters<typeof createMaterialRequestService>[1]["lines"],
) {
  const request = await createMaterialRequestService(actorFor(lead), { ticketId, lines });
  requestIds.push(request.id);
  await submitMaterialRequestService(actorFor(lead), request.id);
  await approveMaterialRequestService(actorFor(officer), {
    requestId: request.id,
    decision: "approved",
  });
  return request;
}

afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { requestId: { in: requestIds } } });
  await db.stockMovement.deleteMany({ where: { stockItemId: { in: stockIds } } });
  await db.materialRequestLine.deleteMany({ where: { requestId: { in: requestIds } } });
  await db.materialRequest.deleteMany({ where: { id: { in: requestIds } } });
  await db.stockItem.deleteMany({ where: { id: { in: stockIds } } });
  await db.methodology.deleteMany({ where: { id: { in: methodologyIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [...requestIds, ...ticketIds, ...accountIds, ...stockIds, ...methodologyIds],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§1's Gate 2 — the three answers", () => {
  it("blocks a ticket nobody has answered", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const ticket = await makeTicket(lead);

    const gate = await materialGateForTicket(ticket.id);
    expect(gate.state).toBe("undecided");
    expect(gate.blocks).toBe(true);
  });

  /** §7: "`N/A` is a legitimate, recorded answer — not a skipped step. The record shows someone decided." */
  it("records the N/A answer with an audit row naming who decided", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const ticket = await makeTicket(lead);

    await markMaterialsNotApplicableService(actorFor(lead), {
      ticketId: ticket.id,
      note: "Customer supplies everything on this call.",
    });

    const gate = await materialGateForTicket(ticket.id);
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);

    const log = await db.auditLog.findFirst({
      where: {
        entityType: TICKET_ENTITY_TYPE,
        entityId: ticket.id,
        action: "materials_not_applicable",
      },
    });
    expect(log?.actorId).toBe(lead.id);
    expect(log?.summary).toMatch(/Customer supplies/);
  });

  it("refuses to record N/A when a live request already says otherwise", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const ticket = await makeTicket(lead);
    const request = await createMaterialRequestService(actorFor(lead), {
      ticketId: ticket.id,
      lines: [
        {
          itemType: "consumable",
          description: "Sealant",
          quantity: 2,
          unit: "tube",
          source: "stock",
        },
      ],
    });
    requestIds.push(request.id);

    await expect(
      markMaterialsNotApplicableService(actorFor(lead), { ticketId: ticket.id }),
    ).rejects.toThrow(/already has a material request/);
  });
});

describe("§7 — the store", () => {
  it("moves the count and records the movement", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);
    const item = await makeStock(storeman, { qtyOnHand: 10 });

    const request = await approvedRequest(lead, officer, ticket.id, [
      {
        itemType: "consumable",
        stockItemId: item.id,
        description: "Gasket set",
        quantity: 4,
        unit: "pc",
        source: "stock",
      },
    ]);

    await issueMaterialsService(actorFor(storeman), {
      requestId: request.id,
      lines: [{ lineNo: 1, quantity: 4 }],
    });

    const after = await db.stockItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(after.qtyOnHand)).toBe(6);

    const movement = await db.stockMovement.findFirst({
      where: { requestId: request.id, type: "issue" },
    });
    expect(Number(movement!.quantity)).toBe(-4);

    const gate = await materialGateForTicket(ticket.id);
    expect(gate.blocks).toBe(false);
  });

  it("refuses to issue more than the store holds", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);
    const item = await makeStock(storeman, { qtyOnHand: 2 });

    const request = await approvedRequest(lead, officer, ticket.id, [
      {
        itemType: "consumable",
        stockItemId: item.id,
        description: "Gasket set",
        quantity: 5,
        unit: "pc",
        source: "stock",
      },
    ]);

    await expect(
      issueMaterialsService(actorFor(storeman), {
        requestId: request.id,
        lines: [{ lineNo: 1, quantity: 5 }],
      }),
    ).rejects.toThrow(/the count stops meaning anything/);
  });

  it("refuses to issue more than was asked for", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);

    const request = await approvedRequest(lead, officer, ticket.id, [
      { itemType: "consumable", description: "Rag", quantity: 2, unit: "pc", source: "stock" },
    ]);

    await expect(
      issueMaterialsService(actorFor(storeman), {
        requestId: request.id,
        lines: [{ lineNo: 1, quantity: 3 }],
      }),
    ).rejects.toThrow(/left to issue/);
  });

  /** §7's one hard refusal. See calibrationCheck for why this is not a warning. */
  it("refuses to issue an instrument that is out of calibration", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);
    const instrument = await makeStock(storeman, {
      name: `Fluke 754 ${suffix}`,
      qtyOnHand: 1,
      calibrationDueAt: new Date(Date.now() - 30 * 86_400_000),
    });

    const request = await approvedRequest(lead, officer, ticket.id, [
      {
        itemType: "instrument",
        stockItemId: instrument.id,
        description: "Fluke 754",
        quantity: 1,
        unit: "pc",
        source: "stock",
      },
    ]);

    await expect(
      issueMaterialsService(actorFor(storeman), {
        requestId: request.id,
        lines: [{ lineNo: 1, quantity: 1 }],
      }),
    ).rejects.toThrow(/out of calibration/);

    // And nothing moved — the refusal happens before any write.
    const after = await db.stockItem.findUniqueOrThrow({ where: { id: instrument.id } });
    expect(Number(after.qtyOnHand)).toBe(1);
  });

  it("records a stock count as a movement, so the change is explainable", async () => {
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const item = await makeStock(storeman, { qtyOnHand: 10 });

    await adjustStockService(actorFor(storeman), { stockItemId: item.id, countedQty: 7 });

    const after = await db.stockItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(after.qtyOnHand)).toBe(7);
    expect(after.lastCountedAt).not.toBeNull();

    const movement = await db.stockMovement.findFirst({
      where: { stockItemId: item.id, type: "adjustment" },
    });
    expect(Number(movement!.quantity)).toBe(-3);
  });
});

describe("§7 — custody", () => {
  /** §7: "Tools disappear otherwise; this is universal." */
  it("keeps an unreturned tool on the custody list until it comes back", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);
    const tool = await makeStock(storeman, { name: `Torque wrench ${suffix}`, qtyOnHand: 3 });

    const request = await approvedRequest(lead, officer, ticket.id, [
      {
        itemType: "tool",
        stockItemId: tool.id,
        description: "Torque wrench",
        quantity: 2,
        unit: "pc",
        source: "stock",
      },
    ]);
    await issueMaterialsService(actorFor(storeman), {
      requestId: request.id,
      lines: [{ lineNo: 1, quantity: 2 }],
    });

    const out = await outstandingCustodyService();
    const mine = out.filter((row) => row.requestId === request.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.outstanding).toBe(2);

    await returnMaterialsService(actorFor(storeman), {
      requestId: request.id,
      lines: [{ lineNo: 1, returned: 2 }],
    });

    const afterReturn = await outstandingCustodyService();
    expect(afterReturn.filter((row) => row.requestId === request.id)).toHaveLength(0);

    // Returned stock goes back on the shelf.
    const item = await db.stockItem.findUniqueOrThrow({ where: { id: tool.id } });
    expect(Number(item.qtyOnHand)).toBe(3);
  });

  it("refuses to account for more than was issued", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const storeman = await makeUser("admin_manager", ["material_request.issue"]);
    const ticket = await makeTicket(lead);

    const request = await approvedRequest(lead, officer, ticket.id, [
      { itemType: "tool", description: "Spanner", quantity: 1, unit: "pc", source: "stock" },
    ]);
    await issueMaterialsService(actorFor(storeman), {
      requestId: request.id,
      lines: [{ lineNo: 1, quantity: 1 }],
    });

    await expect(
      returnMaterialsService(actorFor(storeman), {
        requestId: request.id,
        lines: [{ lineNo: 1, returned: 2 }],
      }),
    ).rejects.toThrow(/would make the custody list wrong/);
  });
});

describe("§7 — the fan-out and the head start", () => {
  /** §7: lines with source = purchase "emit material.purchase_required → module 03". */
  it("tells procurement about the lines that need buying, and holds the ticket", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const officer = await makeUser("operations_manager", ["material_request.approve"]);
    const ticket = await makeTicket(lead);

    const request = await createMaterialRequestService(actorFor(lead), {
      ticketId: ticket.id,
      lines: [
        {
          itemType: "spare_part",
          description: "Special seal",
          quantity: 1,
          unit: "pc",
          source: "purchase",
        },
      ],
    });
    requestIds.push(request.id);
    await submitMaterialRequestService(actorFor(lead), request.id);
    const result = await approveMaterialRequestService(actorFor(officer), {
      requestId: request.id,
      decision: "approved",
    });

    expect(result.status).toBe("purchased");

    const event = await db.eventOutbox.findFirst({
      where: { event: "material.purchase_required", actorId: officer.id },
    });
    expect((event?.payload as { materialRequestId?: string })?.materialRequestId).toBe(request.id);

    const gate = await materialGateForTicket(ticket.id);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/on order/);
  });

  /** §6.2: "Nobody should type the same list twice." */
  it("seeds the lines from the method statement", async () => {
    const lead = await makeUser("technician", ["material_request.raise", "methodology.prepare"]);
    const ticket = await makeTicket(lead);

    const methodology = await createMethodologyService(actorFor(lead), {
      ticketId: ticket.id,
      title: "Method",
    });
    methodologyIds.push(methodology.id);
    await saveMethodologyService(actorFor(lead), {
      methodologyId: methodology.id,
      toolsRequired: ["Torque wrench"],
      materialsRequired: [{ description: "DN100 gasket set", quantity: "2", unit: "set" }],
    });

    const request = await createMaterialRequestService(actorFor(lead), {
      ticketId: ticket.id,
      fromMethodologyId: methodology.id,
    });
    requestIds.push(request.id);

    const read = await getMaterialRequestService(request.id);
    expect(read.lines.map((line) => line.description)).toEqual([
      "DN100 gasket set",
      "Torque wrench",
    ]);
  });

  it("writes an audit row against the request", async () => {
    const lead = await makeUser("technician", ["material_request.raise"]);
    const ticket = await makeTicket(lead);
    const request = await createMaterialRequestService(actorFor(lead), {
      ticketId: ticket.id,
      lines: [
        { itemType: "ppe", description: "Harness", quantity: 1, unit: "pc", source: "stock" },
      ],
    });
    requestIds.push(request.id);

    expect(request.number).toMatch(/^AIESMR-\d{6}$/);
    const log = await db.auditLog.findFirst({
      where: { entityType: MATERIAL_REQUEST_ENTITY_TYPE, entityId: request.id, action: "created" },
    });
    expect(log).not.toBeNull();
  });
});
