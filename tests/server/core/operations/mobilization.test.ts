import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordExternalMethodologyService } from "@/server/core/operations/methodology-service";
import { METHODOLOGY_ENTITY_TYPE } from "@/server/core/operations/methodology-rules";
import {
  demobilizeService,
  departService,
  planMobilizationService,
  readinessForTicketService,
  startWorkService,
  updateMobilizationService,
} from "@/server/core/operations/mobilization-service";
import { MOBILIZATION_ENTITY_TYPE } from "@/server/core/operations/mobilization-rules";
import { addBusinessDays } from "@/server/core/calendar/business-days";
import {
  approveMaterialRequestService,
  createMaterialRequestService,
  issueMaterialsService,
  markMaterialsNotApplicableService,
  submitMaterialRequestService,
  upsertStockItemService,
} from "@/server/core/operations/material-request-service";
import {
  decideCashAdvanceService,
  overrideCashAdvanceGateService,
  releaseCashAdvanceService,
  requestCashAdvanceService,
} from "@/server/core/operations/cash-advance-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import type { TicketType } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §8, against the real database.
 *
 * Three claims that only a real run can settle:
 *
 *  1. **The readiness check reads the other sections' gates**, rather than a copy of their logic.
 *  2. **An officer's override actually opens the check.** Sessions 2 and 4 wrote overrides that move
 *     the ticket's status while the gate function still says no; §8 reads the audit log so the
 *     escape hatch opens something.
 *  3. **Demobilisation corrects both proxy dates.** §5's liquidation deadline and §7's tool-return
 *     date have been derived from the ticket's required-by date because the real demobilisation date
 *     did not exist. This is where it does.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const siteIds: string[] = [];
const contactIds: string[] = [];
const ticketIds: string[] = [];
const mobilizationIds: string[] = [];
const requestIds: string[] = [];
const advanceIds: string[] = [];
const stockIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `mob-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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

/** A ticket whose site has a contact, so §8's customer-contact item can pass. */
async function makeTicket(lead: AuthedUser, type: TicketType = "installation") {
  const account = await db.customerAccount.create({
    data: { code: `MOB-${randomUUID().slice(0, 10)}`, name: `Mob Co ${suffix}`, ownerId: lead.id },
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

  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    siteId: site.id,
    type,
    title: `Mobilise ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Attend and fit.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

/** Everything §8 needs green, short of the mobilisation row's own checklists. */
/**
 * Everything §8 demands before a crew may leave, other than the mobilisation row itself.
 *
 * The method statement joined this list on 2026-08-19, when the company scoped the gate to the jobs
 * that actually take one: new projects **and installations**, which is what these fixtures are. It
 * was previously new-project-only, so an installation was ready without one and these tests passed
 * without ever mentioning it.
 *
 * Satisfied through the external-document path because it is one call rather than five, and because
 * it is a real route a real installation takes — a plant that works to its own permit-to-work form.
 * Driving the full draft → review → approve → submit → decide chain here would test §6.2 twice and
 * bury what these tests are actually about.
 */
async function clearTheGates(lead: AuthedUser, ticketId: string) {
  await markMaterialsNotApplicableService(actorFor(lead), { ticketId });
  await clearMethodStatement(lead, ticketId);
}

/** Split out because a test that issues real materials still has to satisfy §6.2 on its own. */
async function clearMethodStatement(lead: AuthedUser, ticketId: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: ticketId,
      filename: "client-permit-to-work.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: randomUUID(),
      storageKey: `test/${randomUUID()}.pdf`,
      uploaderId: lead.id,
    },
  });

  await recordExternalMethodologyService(actorFor(lead), {
    ticketId,
    title: "Client's permit to work",
    scopeSummary: "Attend and fit, to the plant's own form.",
    approvalFileId: file.id,
    clientApprovedByName: "Plant Engineer",
    clientApprovedAt: new Date(Date.now() - 60_000),
  });
}

async function planned(dispatcher: AuthedUser, ticketId: string) {
  const row = await planMobilizationService(actorFor(dispatcher), {
    ticketId,
    type: "mobilization",
    crewIds: [dispatcher.id],
  });
  mobilizationIds.push(row.id);
  await updateMobilizationService(actorFor(dispatcher), {
    mobilizationId: row.id,
    gatePassStatus: "not_required",
    permitStatus: "not_required",
    ppeChecklist: [{ label: "Harness", checked: true }],
  });
  return row;
}

afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { requestId: { in: requestIds } } });
  await db.stockMovement.deleteMany({ where: { stockItemId: { in: stockIds } } });
  await db.materialRequestLine.deleteMany({ where: { requestId: { in: requestIds } } });
  await db.materialRequest.deleteMany({ where: { id: { in: requestIds } } });
  await db.materialRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.stockItem.deleteMany({ where: { id: { in: stockIds } } });
  await db.cashAdvanceLiquidation.deleteMany({ where: { cashAdvanceId: { in: advanceIds } } });
  await db.approvalAction.deleteMany({ where: { request: { entityId: { in: advanceIds } } } });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: advanceIds } } });
  await db.cashAdvance.deleteMany({ where: { id: { in: advanceIds } } });
  await db.mobilization.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [...ticketIds, ...accountIds, ...mobilizationIds, ...advanceIds, ...requestIds],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.site.deleteMany({ where: { id: { in: siteIds } } });
  await db.contact.deleteMany({ where: { id: { in: contactIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§8's readiness check reads the other sections", () => {
  it("blocks on the materials question nobody has answered", async () => {
    const dispatcher = await makeUser("operations_manager", ["ticket.dispatch", "ticket.view"]);
    const ticket = await makeTicket(dispatcher);

    const readiness = await readinessForTicketService(ticket.id);
    expect(readiness.ready).toBe(false);
    // §7's gate, asked here rather than reimplemented.
    expect(readiness.blockers.map((b) => b.key)).toContain("materials");
  });

  it("is ready once every mandatory item passes", async () => {
    const dispatcher = await makeUser("operations_manager", [
      "ticket.dispatch",
      "ticket.view",
      "material_request.raise",
    ]);
    const ticket = await makeTicket(dispatcher);
    await clearTheGates(dispatcher, ticket.id);
    await planned(dispatcher, ticket.id);

    const readiness = await readinessForTicketService(ticket.id);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it("refuses to send a crew that is not ready, and names what is missing", async () => {
    const dispatcher = await makeUser("operations_manager", ["ticket.dispatch", "ticket.view"]);
    const ticket = await makeTicket(dispatcher);
    const row = await planned(dispatcher, ticket.id);

    await expect(departService(actorFor(dispatcher), row.id)).rejects.toThrow(
      /Not ready to mobilise/,
    );
  });

  /**
   * The gap this session found: sessions 2 and 4's overrides move the ticket's status while the gate
   * function still reads the underlying record and still says no. Without §8 reading the audit log
   * they would open nothing.
   */
  it("lets a cash advance override actually clear the check", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const president = await makeUser("president", [
      "operations.override_ca_gate",
      "ticket.dispatch",
      "ticket.view",
      "material_request.raise",
    ]);
    const ticket = await makeTicket(lead);
    await clearTheGates(president, ticket.id);
    await planned(president, ticket.id);

    // Raising an advance turns the gate on and leaves it unreleased.
    const advance = await requestCashAdvanceService(actorFor(lead), {
      ticketId: ticket.id,
      requestedFor: [lead.id],
      purpose: "Transport for the crew",
      breakdown: [{ category: "transport", description: "Fares", amount: 1_000_00 }],
      neededBy: new Date(),
      submit: true,
    });
    advanceIds.push(advance.id);

    const blocked = await readinessForTicketService(ticket.id);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.map((b) => b.key)).toContain("cash_advance");

    await overrideCashAdvanceGateService(actorFor(president), {
      ticketId: ticket.id,
      reason: "Typhoon repair; the crew is fronting costs and will be reimbursed Monday.",
    });

    const opened = await readinessForTicketService(ticket.id);
    expect(opened.ready).toBe(true);
    expect(opened.items.find((item) => item.key === "cash_advance")!.detail).toMatch(/Typhoon/);
    void vp;
  });
});

describe("§8 — going and coming back", () => {
  it("moves the ticket through mobilized and in_progress", async () => {
    const dispatcher = await makeUser("operations_manager", [
      "ticket.dispatch",
      "ticket.view",
      "material_request.raise",
    ]);
    const ticket = await makeTicket(dispatcher);
    await clearTheGates(dispatcher, ticket.id);
    const row = await planned(dispatcher, ticket.id);

    await departService(actorFor(dispatcher), row.id);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      "mobilized",
    );

    await startWorkService(actorFor(dispatcher), row.id);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      "in_progress",
    );

    const event = await db.eventOutbox.findFirst({
      where: { event: "ticket.mobilized", actorId: dispatcher.id },
    });
    expect((event?.payload as { ticketId?: string })?.ticketId).toBe(ticket.id);
  });

  /**
   * §5's liquidation deadline has been three working days after the ticket's *required-by* date
   * because the real demobilisation date did not exist. This is where it does.
   */
  it("corrects the cash advance liquidation deadline from the real demobilisation date", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const dispatcher = await makeUser("operations_manager", [
      "ticket.dispatch",
      "ticket.view",
      "material_request.raise",
    ]);
    const ticket = await makeTicket(lead);
    await clearTheGates(dispatcher, ticket.id);

    const advance = await requestCashAdvanceService(actorFor(lead), {
      ticketId: ticket.id,
      requestedFor: [lead.id],
      purpose: "Fares and meals",
      breakdown: [{ category: "transport", description: "Fares", amount: 2_000_00 }],
      neededBy: new Date(),
      submit: true,
    });
    advanceIds.push(advance.id);
    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
      // A deliberately distant proxy, so the correction is unmistakable.
      expectedDemobilisation: new Date("2026-01-05T00:00:00.000Z"),
    });

    const before = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(before.liquidationDueAt!.getFullYear()).toBe(2026);
    expect(before.liquidationDueAt!.getMonth()).toBe(0);

    const row = await planned(dispatcher, ticket.id);
    await departService(actorFor(dispatcher), row.id);
    const result = await demobilizeService(actorFor(dispatcher), { mobilizationId: row.id });

    const after = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    const expected = addBusinessDays(new Date(), 3);
    expect(after.liquidationDueAt!.toISOString().slice(0, 10)).toBe(
      expected.toISOString().slice(0, 10),
    );
    expect(result.advances).toContain(advance.number);
  });

  /** §7's tools are due back on demobilisation, which until now was a proxy too. */
  it("reports what did not come back and corrects the tool return date", async () => {
    const dispatcher = await makeUser("operations_manager", [
      "ticket.dispatch",
      "ticket.view",
      "material_request.raise",
      "material_request.approve",
      "material_request.issue",
    ]);
    const ticket = await makeTicket(dispatcher);
    // This one issues materials for real rather than waiving them, so it clears §6.2 on its own.
    await clearMethodStatement(dispatcher, ticket.id);

    const stock = await upsertStockItemService(actorFor(dispatcher), {
      sku: `SKU-${randomUUID().slice(0, 10)}`,
      name: `Torque wrench ${suffix}`,
      category: "tool",
      unit: "pc",
      qtyOnHand: 2,
    });
    stockIds.push(stock.id);

    const request = await createMaterialRequestService(actorFor(dispatcher), {
      ticketId: ticket.id,
      lines: [
        {
          itemType: "tool",
          stockItemId: stock.id,
          description: "Torque wrench",
          quantity: 1,
          unit: "pc",
          source: "stock",
        },
      ],
    });
    requestIds.push(request.id);
    await submitMaterialRequestService(actorFor(dispatcher), request.id);
    await approveMaterialRequestService(actorFor(dispatcher), {
      requestId: request.id,
      decision: "approved",
    });
    await issueMaterialsService(actorFor(dispatcher), {
      requestId: request.id,
      lines: [{ lineNo: 1, quantity: 1 }],
    });

    const row = await planned(dispatcher, ticket.id);
    await departService(actorFor(dispatcher), row.id);
    const result = await demobilizeService(actorFor(dispatcher), { mobilizationId: row.id });

    // Reported, not refused — the loss is recorded rather than hidden.
    expect(result.checklist.toolsReconciled).toBe(false);
    expect(result.checklist.message).toMatch(/Torque wrench/);

    const after = await db.materialRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.returnDueAt!.toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );

    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("qa");
  });

  it("writes an audit row against the mobilisation", async () => {
    const dispatcher = await makeUser("operations_manager", ["ticket.dispatch", "ticket.view"]);
    const ticket = await makeTicket(dispatcher);
    const row = await planned(dispatcher, ticket.id);

    const log = await db.auditLog.findFirst({
      where: { entityType: MOBILIZATION_ENTITY_TYPE, entityId: row.id, action: "planned" },
    });
    expect(log).not.toBeNull();
  });
});
