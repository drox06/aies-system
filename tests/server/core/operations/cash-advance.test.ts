import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  cashAdvanceGateForTicket,
  decideCashAdvanceService,
  decideExtensionService,
  endorseCashAdvanceService,
  getCashAdvanceService,
  liquidateCashAdvanceService,
  listCashAdvancesService,
  reviewLiquidationService,
  overrideCashAdvanceGateService,
  releaseCashAdvanceService,
  requestCashAdvanceService,
  requestEligibilityService,
  requestExtensionService,
  sweepOverdueLiquidationsService,
} from "@/server/core/operations/cash-advance-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import { CASH_ADVANCE_ENTITY_TYPE } from "@/server/core/operations/cash-advance-rules";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §5, against the real database.
 *
 * §20's fourth case, in full: "**Cash advance gate blocks mobilization; override is logged;
 * liquidation overdue blocks the next request.**"
 *
 * The pure rules are covered in cash-advance-rules.test.ts. What is here is everything a rule
 * cannot prove: that the number is really allocated, that the approval really routes through module
 * 00's engine and refuses an ineligible approver, that the ticket status really moves, that the
 * override really writes an audit row, and that the nightly sweep really marks and really blocks.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const advanceIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `ca-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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

/** §4's standalone ticket is the cheapest real ticket — no order, no quotation, no PO. */
async function makeTicket(lead: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `CA-${randomUUID().slice(0, 12)}`, name: `CA Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);

  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type: "after_sales",
    subType: "corrective",
    title: `Pump callout ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Attend site, diagnose, repair.",
    justification: "Warranty callback under the original supply.",
    billable: false,
  });
  ticketIds.push(ticket.id);
  return ticket;
}

async function requestFor(lead: AuthedUser, ticketId: string, amountCentavos = 5_000_00) {
  const advance = await requestCashAdvanceService(actorFor(lead), {
    ticketId,
    requestedFor: [lead.id],
    purpose: "Transport, fuel and meals for a two-day callout",
    breakdown: [
      { category: "transport", description: "Bus fares", amount: Math.round(amountCentavos * 0.4) },
      {
        category: "fuel",
        description: "Service vehicle",
        amount: Math.round(amountCentavos * 0.4),
      },
      {
        category: "meals",
        description: "Two days, two crew",
        amount: Math.round(amountCentavos * 0.2),
      },
    ],
    neededBy: new Date(Date.now() + 86_400_000),
    submit: true,
  });
  advanceIds.push(advance.id);
  return advance;
}

afterAll(async () => {
  await db.cashAdvanceLiquidation.deleteMany({ where: { cashAdvanceId: { in: advanceIds } } });
  await db.cashAdvance.deleteMany({ where: { id: { in: advanceIds } } });
  await db.approvalAction.deleteMany({
    where: { request: { entityId: { in: advanceIds } } },
  });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: advanceIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...advanceIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§5 — the request", () => {
  it("allocates a house-format number and moves the ticket to cash_advance_pending", async () => {
    const lead = await makeUser("technician", ["ticket.view", "cash_advance.request"]);
    const ticket = await makeTicket(lead);

    // A standalone ticket starts `generated` with the gate not yet engaged.
    expect(ticket.status).toBe("generated");

    const advance = await requestFor(lead, ticket.id);
    expect(advance.number).toMatch(/^AIESCA-\d{6}$/);
    expect(advance.status).toBe("pending_approval");

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.cashAdvanceRequired).toBe(true);
    expect(after.status).toBe("cash_advance_pending");
  });

  it("refuses a category that is not one of §5's eight", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const ticket = await makeTicket(lead);

    await expect(
      requestCashAdvanceService(actorFor(lead), {
        ticketId: ticket.id,
        requestedFor: [],
        purpose: "Something",
        breakdown: [{ category: "entertainment", description: "", amount: 100_00 }],
        neededBy: new Date(),
        submit: true,
      }),
    ).rejects.toThrow(/not one of the eight/);
  });

  it("emits cash_advance.requested", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const event = await db.eventOutbox.findFirst({
      where: { event: "cash_advance.requested", actorId: lead.id },
    });
    expect(event).not.toBeNull();
    expect((event!.payload as { cashAdvanceId?: string }).cashAdvanceId).toBe(advance.id);
  });
});

describe("§5 — the gate", () => {
  it("blocks mobilization until the money is released, not until it is approved", async () => {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const pending = await cashAdvanceGateForTicket(ticket.id);
    expect(pending.blocks).toBe(true);

    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });

    // The crucial assertion: approved is not released, and the gate knows the difference.
    const approved = await cashAdvanceGateForTicket(ticket.id);
    expect(approved.blocks).toBe(true);
    expect(approved.message).toMatch(/not been handed over/);

    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
    });

    const released = await cashAdvanceGateForTicket(ticket.id);
    expect(released.blocks).toBe(false);

    // The ticket stops waiting on the gate, and stops at `ready_to_mobilize` — §8 owns actually
    // sending anybody, and §7's material gate may still be shut.
    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("ready_to_mobilize");
  });

  it("sets a liquidation deadline on release, three working days out", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    // A Thursday: Friday, Monday, Tuesday.
    const result = await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "gcash",
      expectedDemobilisation: new Date("2026-08-13T02:00:00.000Z"),
    });

    expect(result.liquidationDueAt.toISOString().slice(0, 10)).toBe("2026-08-18");
  });

  /** §20: "override is logged". The reason surviving is the entire value of the override. */
  it("logs an override with its reason, and refuses one without", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const president = await makeUser("president", ["operations.override_ca_gate"]);
    const ticket = await makeTicket(lead);
    await requestFor(lead, ticket.id);

    await expect(
      overrideCashAdvanceGateService(actorFor(president), {
        ticketId: ticket.id,
        reason: "urgent",
      }),
    ).rejects.toThrow(/reason somebody can read/);

    await overrideCashAdvanceGateService(actorFor(president), {
      ticketId: ticket.id,
      reason: "Typhoon repair for the water district; crew fronting costs, reimbursed Monday.",
    });

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("ready_to_mobilize");

    const log = await db.auditLog.findFirst({
      where: {
        entityType: TICKET_ENTITY_TYPE,
        entityId: ticket.id,
        action: "cash_advance_gate_overridden",
      },
    });
    expect(log).not.toBeNull();
    expect(log!.summary).toContain("Typhoon repair");
  });

  it("refuses an override when nothing is blocking", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const president = await makeUser("president", ["operations.override_ca_gate"]);
    const ticket = await makeTicket(lead);

    await expect(
      overrideCashAdvanceGateService(actorFor(president), {
        ticketId: ticket.id,
        reason: "No advance was ever needed on this ticket at all.",
      }),
    ).rejects.toThrow(/nothing to override/);
  });
});

describe("§5 — approval routing", () => {
  /**
   * §5: "The Vice President approves every advance, at any amount."
   *
   * The engine, not this module, decides eligibility — so the test that matters is that somebody
   * without the role is refused by the real machinery rather than by a check written here.
   */
  it("refuses an approver the engine does not consider eligible", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const impostor = await makeUser("finance_officer", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await expect(
      decideCashAdvanceService(actorFor(impostor), impostor, {
        cashAdvanceId: advance.id,
        decision: "approved",
      }),
    ).rejects.toThrow(/not eligible/);
  });

  it("routes through a rule whose window is four hours, not twenty-four", async () => {
    const rule = await db.approvalRule.findUniqueOrThrow({
      where: { key: "cash_advance.approve" },
    });
    expect(rule.escalateAfterHours).toBe(4);
    expect(rule.primaryApproverRole).toBe("vice_president");
    expect(rule.fallbackApproverRole).toBe("president");
  });

  it("requires a reason to send an advance back", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await expect(
      decideCashAdvanceService(actorFor(vp), vp, {
        cashAdvanceId: advance.id,
        decision: "rejected",
      }),
    ).rejects.toThrow(/Say why/);
  });
});

/**
 * PD's or DJ's endorsement, ahead of the Vice President's own decision (docs/DECISIONS.md #175, EA's
 * own correction to #151: "PD and DJ approval are more akin to endorsement to KJ").
 *
 * Deliberately outside the `ApprovalRequest` engine — see `endorseCashAdvanceService`'s doc comment
 * for why — so what matters here is exactly the boundary that separation creates: endorsing must
 * never let money move on its own, and must never get in the way of the Vice President's existing,
 * unmodified authority to decide directly.
 */
describe("§5's endorsement — PD's or DJ's, ahead of the Vice President (#175)", () => {
  it("moves a pending advance to endorsed and records who", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const pd = await makeUser("admin_manager", ["cash_advance.endorse"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const result = await endorseCashAdvanceService(actorFor(pd), advance.id);
    expect(result.status).toBe("endorsed");

    const after = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(after.status).toBe("endorsed");
    expect(after.endorsedById).toBe(pd.id);
    expect(after.endorsedAt).not.toBeNull();
  });

  it("does not release money on its own — an endorsed advance still blocks the gate", async () => {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const dj = await makeUser("operations_manager", ["cash_advance.endorse"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await endorseCashAdvanceService(actorFor(dj), advance.id);

    const gate = await cashAdvanceGateForTicket(ticket.id);
    expect(gate.blocks).toBe(true);
  });

  it("does not block the Vice President from deciding straight from pending_approval", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    // Nobody endorsed this — the Vice President's existing, direct authority is unchanged.
    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });

    const after = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(after.status).toBe("approved");
  });

  it("lets the Vice President decide an endorsed advance, which finally releases it", async () => {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const pd = await makeUser("admin_manager", ["cash_advance.endorse"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await endorseCashAdvanceService(actorFor(pd), advance.id);
    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });

    const after = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(after.status).toBe("approved");

    // Only now can the money actually move.
    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
    });
    const gate = await cashAdvanceGateForTicket(ticket.id);
    expect(gate.blocks).toBe(false);
  });

  it("refuses to endorse anything other than a pending advance", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const pd = await makeUser("admin_manager", ["cash_advance.endorse"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await endorseCashAdvanceService(actorFor(pd), advance.id);
    await expect(endorseCashAdvanceService(actorFor(pd), advance.id)).rejects.toThrow(
      /nothing to endorse/,
    );
  });
});

/**
 * The failure AIESCA-260127 hit in production on 2026-08-18.
 *
 * Its approval request reached `approved` and the advance stayed `pending_approval`, because the
 * engine's decision and the advance's own update were two commits and only the first landed. Every
 * route out was then closed: approving refused ("has no open approval request", since the request
 * was no longer pending) and re-submitting refused ("not a draft").
 *
 * Two guarantees, and the second is the one that matters for rows already in that state — a fix
 * that only prevents new occurrences leaves the existing record dead.
 */
describe("§5 — a decision that only half landed", () => {
  it("finishes an advance whose approval was already decided", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    // Reproduce the stranded state exactly: the engine decided, the advance never caught up.
    const request = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: CASH_ADVANCE_ENTITY_TYPE, entityId: advance.id, status: "pending" },
    });
    await db.approvalRequest.update({
      where: { id: request.id },
      data: { status: "approved", decidedAt: new Date() },
    });
    await db.approvalAction.create({
      data: {
        requestId: request.id,
        step: 0,
        approverId: vp.id,
        decision: "approved",
        isFallback: false,
      },
    });

    const stranded = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(stranded.status).toBe("pending_approval");

    // The screen now heals it instead of refusing.
    const result = await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    expect(result.status).toBe("approved");

    const healed = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(healed.status).toBe("approved");
    expect(healed.amountApproved).not.toBeNull();
    // The decision belongs to whoever actually made it, not to whoever pressed the button after.
    expect(healed.approvedById).toBe(vp.id);
  });

  it("applies a recorded rejection as a rejection, not as an approval", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const request = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: CASH_ADVANCE_ENTITY_TYPE, entityId: advance.id, status: "pending" },
    });
    await db.approvalRequest.update({
      where: { id: request.id },
      data: { status: "rejected", decidedAt: new Date() },
    });
    await db.approvalAction.create({
      data: {
        requestId: request.id,
        step: 0,
        approverId: vp.id,
        decision: "rejected",
        comment: "Breakdown does not add up.",
        isFallback: false,
      },
    });

    // Note the caller asks to *approve*. What is applied is what was decided.
    const result = await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    expect(result.status).toBe("rejected");

    const healed = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(healed.status).toBe("rejected");
    expect(healed.rejectionReason).toBe("Breakdown does not add up.");
    expect(healed.amountApproved).toBeNull();
  });

  it("still refuses when there is no decision anywhere", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await db.approvalRequest.deleteMany({
      where: { entityType: CASH_ADVANCE_ENTITY_TYPE, entityId: advance.id },
    });

    await expect(
      decideCashAdvanceService(actorFor(vp), vp, {
        cashAdvanceId: advance.id,
        decision: "approved",
      }),
    ).rejects.toThrow(/no open approval request/);
  });
});

describe("§5 — liquidation", () => {
  async function releasedAdvance(amountCentavos = 5_000_00) {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id, amountCentavos);
    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
    });
    return { lead, vp, finance, ticket, advance };
  }

  it("stays partially liquidated while money is still unaccounted for", async () => {
    const { lead, advance } = await releasedAdvance();

    const result = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "fuel",
          description: "Diesel",
          amount: 2_000_00,
          hasOfficialReceipt: true,
        },
      ],
    });

    expect(result.settled).toBe(false);
    expect(result.unaccounted).toBe(3_000_00);

    const row = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(row.status).toBe("partially_liquidated");
  });

  it("settles when receipts and returned cash together cover the release", async () => {
    const { lead, advance } = await releasedAdvance();

    await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "fuel",
          description: "Diesel",
          amount: 2_000_00,
          hasOfficialReceipt: true,
        },
      ],
    });

    // A second envelope, reconciling against the whole advance rather than against itself.
    const second = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-21",
          category: "meals",
          description: "Crew meals",
          amount: 1_000_00,
          hasOfficialReceipt: false,
        },
      ],
      amountReturnedCentavos: 2_000_00,
    });

    expect(second.settled).toBe(true);
    expect(second.withoutOfficialReceipt).toBe(1);

    const row = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    // `pending_settlement`, not `liquidated`: since 2026-08-16 the numbers reconciling is not the
    // end of it — finance checks the physical official receipts first. See reviewLiquidationService.
    expect(row.status).toBe("pending_settlement");
    expect(Number(row.amountLiquidated)).toBe(3_000);
    expect(Number(row.amountReturned)).toBe(2_000);
  });

  /**
   * §5's review cycle, wired on 2026-08-16 after the company pointed out that filing receipts in the
   * app is a claim, not proof. What makes a cost deductible is a BIR official receipt on paper.
   */
  it("stops at pending_settlement rather than settling itself", async () => {
    const { lead, advance } = await releasedAdvance();

    const result = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "fuel",
          description: "Diesel",
          amount: 3_000_00,
          hasOfficialReceipt: true,
        },
      ],
      amountReturnedCentavos: 2_000_00,
    });
    expect(result.settled).toBe(true);

    const row = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(row.status).toBe("pending_settlement");
    expect(row.liquidatedAt).toBeNull();

    // Not chased and not blocking: the technician has done their part.
    expect((await requestEligibilityService(lead.id)).allowed).toBe(true);
  });

  it("settles only once somebody has checked the physical receipts", async () => {
    const { lead, advance } = await releasedAdvance();
    const finance = await makeUser("finance_officer", ["cash_advance.review_liquidation"]);

    const filed = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "fuel",
          description: "Diesel",
          amount: 5_000_00,
          hasOfficialReceipt: true,
        },
      ],
    });

    await reviewLiquidationService(actorFor(finance), {
      liquidationId: filed.id,
      decision: "approved",
    });

    const row = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(row.status).toBe("liquidated");
    expect(row.liquidatedAt).not.toBeNull();
  });

  it("sends a liquidation back with a reason, and reopens the advance", async () => {
    const { lead, advance } = await releasedAdvance();
    const finance = await makeUser("finance_officer", ["cash_advance.review_liquidation"]);

    const filed = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "fuel",
          description: "Diesel",
          amount: 5_000_00,
          hasOfficialReceipt: true,
        },
      ],
    });

    await expect(
      reviewLiquidationService(actorFor(finance), {
        liquidationId: filed.id,
        decision: "rejected",
      }),
    ).rejects.toThrow(/Say what is wrong/);

    await reviewLiquidationService(actorFor(finance), {
      liquidationId: filed.id,
      decision: "rejected",
      remarks: "Only two of the four official receipts arrived.",
    });

    const row = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(row.status).toBe("partially_liquidated");
    expect(row.liquidatedAt).toBeNull();
  });

  it("records a reimbursement when the crew overspent", async () => {
    const { lead, advance } = await releasedAdvance(1_000_00);

    const result = await liquidateCashAdvanceService(actorFor(lead), {
      cashAdvanceId: advance.id,
      lines: [
        {
          date: "2026-08-20",
          category: "accommodation",
          description: "Extra night, flight cancelled",
          amount: 1_450_00,
          hasOfficialReceipt: true,
        },
      ],
    });

    expect(result.settled).toBe(true);
    expect(result.balanceReimbursable).toBe(450_00);
  });

  it("will not let somebody liquidate an advance that is not theirs", async () => {
    const { advance } = await releasedAdvance();
    const stranger = await makeUser("technician", ["cash_advance.request"]);

    await expect(
      liquidateCashAdvanceService(actorFor(stranger), {
        cashAdvanceId: advance.id,
        lines: [
          {
            date: "2026-08-20",
            category: "fuel",
            description: "x",
            amount: 100_00,
            hasOfficialReceipt: true,
          },
        ],
      }),
    ).rejects.toThrow(/not yours to liquidate/);
  });
});

describe("§5 — overdue liquidation blocks the next request", () => {
  /** §20's third clause, end to end: sweep marks it, and the block bites on a real request. */
  it("marks the advance overdue, then refuses the next request", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", ["cash_advance.approve"]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
    });

    // Backdate the deadline rather than waiting three working days for it.
    await db.cashAdvance.update({
      where: { id: advance.id },
      data: { liquidationDueAt: new Date(Date.now() - 5 * 86_400_000) },
    });

    expect((await requestEligibilityService(lead.id)).allowed).toBe(false);

    await sweepOverdueLiquidationsService();
    const swept = await db.cashAdvance.findUniqueOrThrow({ where: { id: advance.id } });
    expect(swept.status).toBe("overdue_liquidation");

    /*
      Matched on the payload, not on "the most recent one".

      The original read the newest `cash_advance.liquidation_overdue` in the whole outbox and assumed
      it was this test's. It held until 2026-08-21, when a seeded walkthrough advance reached its own
      liquidation date and the same sweep marked it too — so the newest event belonged to somebody
      else and a correct sweep failed a correct test. Shared database, shared outbox: a test that
      says "the latest row is mine" is making a claim about everything else running.
    */
    const event = await db.eventOutbox.findFirst({
      where: {
        event: "cash_advance.liquidation_overdue",
        payload: { path: ["cashAdvanceId"], equals: advance.id },
      },
    });
    expect((event?.payload as { cashAdvanceId?: string })?.cashAdvanceId).toBe(advance.id);

    const secondTicket = await makeTicket(lead);
    await expect(requestFor(lead, secondTicket.id)).rejects.toThrow(/before requesting another/);
  });

  /**
   * §5: "Extensions are approved by the Vice President… never a silent edit of the deadline."
   *
   * Both halves are asserted: filing the request must *not* move the deadline, and approving it
   * must. The first is the one that matters — if a request alone moved it, anybody could extend
   * their own deadline by filing a form.
   */
  it("does not move the deadline until the Vice President grants the extension", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const vp = await makeUser("vice_president", [
      "cash_advance.approve",
      "cash_advance.approve_extension",
    ]);
    const finance = await makeUser("finance_officer", ["cash_advance.release"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await decideCashAdvanceService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });
    await releaseCashAdvanceService(actorFor(finance), {
      cashAdvanceId: advance.id,
      method: "cash",
    });
    await db.cashAdvance.update({
      where: { id: advance.id },
      data: { liquidationDueAt: new Date(Date.now() - 5 * 86_400_000) },
    });

    const newDueAt = new Date(Date.now() + 10 * 86_400_000);
    await requestExtensionService(actorFor(lead), {
      cashAdvanceId: advance.id,
      reason: "Receipts are with the driver who is still on the Visayas route.",
      newDueAt,
    });

    // Requested, not granted: still late, still blocked.
    const whileWaiting = await getCashAdvanceService(
      { ...lead, permissions: new Set(["cash_advance.view_register"]) },
      advance.id,
    );
    expect(whileWaiting.standing.state).toBe("late");
    expect((await requestEligibilityService(lead.id)).allowed).toBe(false);

    await decideExtensionService(actorFor(vp), vp, {
      cashAdvanceId: advance.id,
      decision: "approved",
    });

    const granted = await getCashAdvanceService(
      { ...lead, permissions: new Set(["cash_advance.view_register"]) },
      advance.id,
    );
    expect(granted.standing.state).toBe("extended");
    expect(granted.standing.extensionReason).toMatch(/Visayas/);
    expect((await requestEligibilityService(lead.id)).allowed).toBe(true);
    // Raised from the 20s global rather than raising the global itself. This is the longest chain
    // in the file — three users, a ticket, an advance, an approval, a release, an extension request
    // and an extension decision, each a multi-statement transaction against a pooler in another
    // country. A global bump would hide a genuine hang somewhere else.
  }, 60_000);
});

describe("§19 — who sees what", () => {
  it("keeps a technician out of somebody else's advance", async () => {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const other = await makeUser("technician", ["ticket.view"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    await expect(getCashAdvanceService(other, advance.id)).rejects.toThrow(/visible to the people/);
    // The person it covers can see it.
    await expect(getCashAdvanceService(lead, advance.id)).resolves.toBeTruthy();
  });

  it("scopes the register to a technician's own advances", async () => {
    const lead = await makeUser("technician", ["cash_advance.request", "ticket.view"]);
    const other = await makeUser("technician", ["ticket.view"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const mine = await listCashAdvancesService(lead, { scope: "all" });
    expect(mine.map((row) => row.id)).toContain(advance.id);

    const theirs = await listCashAdvancesService(other, { scope: "all" });
    expect(theirs.map((row) => row.id)).not.toContain(advance.id);
  });

  it("writes an audit row the register can read back", async () => {
    const lead = await makeUser("technician", ["cash_advance.request"]);
    const ticket = await makeTicket(lead);
    const advance = await requestFor(lead, ticket.id);

    const log = await db.auditLog.findFirst({
      where: { entityType: CASH_ADVANCE_ENTITY_TYPE, entityId: advance.id, action: "requested" },
    });
    expect(log).not.toBeNull();
  });
});
