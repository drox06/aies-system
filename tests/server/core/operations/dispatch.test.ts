import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bumpForEmergencyService,
  capacityService,
  dispatchBoardService,
  recordUnavailabilityService,
  previewScheduleService,
  scheduleTicketService,
} from "@/server/core/operations/dispatch-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";

/**
 * specs/04-operations-projects.md §17, against the real database.
 *
 * What only a real run settles:
 *
 *  1. **A conflict is reported, not refused.** The rules can compute one; whether the service still
 *     writes the schedule is a decision that only shows up here.
 *  2. **A bump notifies.** §17 asks for "notifications to affected owners", and moving somebody's
 *     Thursday without telling them is worse than not moving it — they turn up at the original site.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `dsp-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "DJ (operations)" };

const accountIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];
const availabilityIds: string[] = [];

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

async function makeUser() {
  const user = await db.user.create({
    data: {
      email: `dsp-${randomUUID().slice(0, 8)}@test.local`,
      name: `Tech ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeTicket(over: Record<string, unknown> = {}) {
  const account = await db.customerAccount.create({
    data: { code: `DSP-${randomUUID().slice(0, 12)}`, name: `DSP Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const ticket = await createStandaloneTicketService(actor, {
    accountId: account.id,
    type: "installation",
    title: `Job ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do the work.",
    justification: "Standalone for the dispatch fixture.",
    ...over,
  });
  ticketIds.push(ticket.id);
  return ticket;
}

afterAll(async () => {
  await db.notification.deleteMany({ where: { entityId: { in: ticketIds } } });
  await db.technicianAvailability.deleteMany({ where: { id: { in: availabilityIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("putting a ticket on the board", () => {
  it("records the scheduled window separately from the required-by date", async () => {
    const ticket = await makeTicket({ requiredByDate: inDays(20) });
    await scheduleTicketService(actor, { ticketId: ticket.id, scheduledStart: inDays(3) });

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.scheduledStart).not.toBeNull();
    // The promise and the plan are different facts, and the gap between them is what a dispatcher
    // manages. Conflating them would make the board show the promise.
    expect(after.requiredByDate).not.toEqual(after.scheduledStart);
  });

  it("refuses a window that finishes before it starts", async () => {
    const ticket = await makeTicket();
    await expect(
      scheduleTicketService(actor, {
        ticketId: ticket.id,
        scheduledStart: inDays(5),
        scheduledEnd: inDays(2),
      }),
    ).rejects.toThrow(/cannot finish before it starts/);
  });

  it("takes a ticket back off the board", async () => {
    const ticket = await makeTicket();
    await scheduleTicketService(actor, { ticketId: ticket.id, scheduledStart: inDays(2) });
    await scheduleTicketService(actor, { ticketId: ticket.id, scheduledStart: null });

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.scheduledStart).toBeNull();
  });

  /**
   * The decision this file exists to pin. A dispatcher putting one person on two short jobs in the
   * same estate is doing their job; refusing it teaches people to schedule on paper instead, and
   * then the board is wrong about everything rather than about one day.
   */
  it("writes a double-booking and reports it rather than refusing", async () => {
    const tech = await makeUser();
    const day = inDays(4);

    const first = await makeTicket();
    const second = await makeTicket();

    await scheduleTicketService(actor, {
      ticketId: first.id,
      scheduledStart: day,
      assignedLeadId: tech.id,
    });
    const result = await scheduleTicketService(actor, {
      ticketId: second.id,
      scheduledStart: day,
      assignedLeadId: tech.id,
    });

    // Written.
    const after = await db.ticket.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.scheduledStart).not.toBeNull();

    // And reported.
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]!.reason).toMatch(/2 jobs the same day/);
  });

  it("reports scheduling somebody who is away, and says why", async () => {
    const tech = await makeUser();
    const availability = await recordUnavailabilityService(actor, {
      userId: tech.id,
      fromDate: inDays(6),
      toDate: inDays(10),
      kind: "training",
      notes: "Vendor course",
    });
    availabilityIds.push(availability.id);

    const ticket = await makeTicket();
    const result = await scheduleTicketService(actor, {
      ticketId: ticket.id,
      scheduledStart: inDays(7),
      assignedLeadId: tech.id,
    });

    expect(result.conflicts.some((conflict) => /Training/.test(conflict.reason))).toBe(true);
  });
});

describe("what the board shows", () => {
  it("colours a card from §8's readiness rather than assuming it is fine", async () => {
    const tech = await makeUser();
    const ticket = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: ticket.id,
      scheduledStart: inDays(2),
      assignedLeadId: tech.id,
    });

    const board = await dispatchBoardService({ weekOf: inDays(2) });
    const card = board.cards.find((entry) => entry.id === ticket.id);

    expect(card).toBeDefined();
    // Scheduled, so it is either ready or blocked — never "unscheduled".
    expect(["ready", "blocked"]).toContain(card!.card.state);
  });

  it("lists the technicians who actually have work that week", async () => {
    const tech = await makeUser();
    const ticket = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: ticket.id,
      scheduledStart: inDays(1),
      assignedLeadId: tech.id,
    });

    const board = await dispatchBoardService({ weekOf: inDays(1) });
    expect(board.technicians.map((t) => t.id)).toContain(tech.id);
    expect(board.days).toHaveLength(7);
  });
});

describe("§17's emergency injection", () => {
  /**
   * "Emergency and warranty tickets can be injected, bumping lower-priority work with notifications
   * to affected owners." The notification is the requirement — a bump nobody is told about means
   * somebody drives to the original site.
   */
  it("moves the work and notifies whoever was on it", async () => {
    const tech = await makeUser();
    const day = inDays(5);

    const planned = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: planned.id,
      scheduledStart: day,
      assignedLeadId: tech.id,
    });

    const emergency = await makeTicket({ priority: "emergency" });

    const result = await bumpForEmergencyService(actor, {
      emergencyTicketId: emergency.id,
      scheduledStart: day,
      bumpTicketIds: [planned.id],
    });

    expect(result.bumped).toBe(1);
    expect(result.notified).toBeGreaterThan(0);

    const after = await db.ticket.findUniqueOrThrow({ where: { id: planned.id } });
    expect(after.scheduledStart).toBeNull();

    const told = await db.notification.count({
      where: { recipientId: tech.id, entityId: planned.id },
    });
    expect(told).toBeGreaterThan(0);
  });

  /** Only emergencies and after-sales callbacks may displace committed work. */
  it("refuses to bump for an ordinary job", async () => {
    const planned = await makeTicket();
    const ordinary = await makeTicket();

    await expect(
      bumpForEmergencyService(actor, {
        emergencyTicketId: ordinary.id,
        scheduledStart: inDays(5),
        bumpTicketIds: [planned.id],
      }),
    ).rejects.toThrow(/neither an emergency nor an after-sales callback/);
  });
});

describe("checking a booking before making it", () => {
  /**
   * The company asked for confirm-or-cancel rather than a notice afterwards, which means the answer
   * has to come **before** the write. An undo leaves a window where the board is wrong, and somebody
   * who closes the tab mid-decision leaves it wrong for good.
   */
  it("reports the clash without booking anything", async () => {
    const tech = await makeUser();
    const day = inDays(9);

    const first = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: first.id,
      scheduledStart: day,
      assignedLeadId: tech.id,
    });

    const second = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: second.id,
      scheduledStart: null,
      assignedLeadId: tech.id,
    });

    const preview = await previewScheduleService({
      ticketId: second.id,
      scheduledStart: day,
    });

    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(preview.conflicts[0]!.otherTickets).toContain(first.number);
    expect(preview.conflicts[0]!.who).toBe(tech.name);

    // Nothing written. This is the whole point of previewing.
    const after = await db.ticket.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.scheduledStart).toBeNull();
  });

  it("says nothing when the day is free", async () => {
    const tech = await makeUser();
    const ticket = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: ticket.id,
      scheduledStart: null,
      assignedLeadId: tech.id,
    });

    const preview = await previewScheduleService({
      ticketId: ticket.id,
      scheduledStart: inDays(11),
    });
    expect(preview.conflicts).toEqual([]);
  });

  /**
   * A clash between two *other* jobs is not this dispatcher's decision and would read as noise on a
   * confirmation dialog — which is how people learn to click through dialogs without reading them.
   */
  it("reports only what this booking causes", async () => {
    const busy = await makeUser();
    const free = await makeUser();
    const day = inDays(12);

    const a = await makeTicket();
    const b = await makeTicket();
    for (const ticket of [a, b]) {
      await scheduleTicketService(actor, {
        ticketId: ticket.id,
        scheduledStart: day,
        assignedLeadId: busy.id,
      });
    }

    const mine = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: mine.id,
      scheduledStart: null,
      assignedLeadId: free.id,
    });

    const preview = await previewScheduleService({ ticketId: mine.id, scheduledStart: day });
    expect(preview.conflicts).toEqual([]);
  });

  it("warns about somebody on leave before the booking is made", async () => {
    const tech = await makeUser();
    const availability = await recordUnavailabilityService(actor, {
      userId: tech.id,
      fromDate: inDays(14),
      toDate: inDays(18),
      kind: "leave",
      notes: "Annual",
    });
    availabilityIds.push(availability.id);

    const ticket = await makeTicket();
    await scheduleTicketService(actor, {
      ticketId: ticket.id,
      scheduledStart: null,
      assignedLeadId: tech.id,
    });

    const preview = await previewScheduleService({
      ticketId: ticket.id,
      scheduledStart: inDays(15),
    });
    expect(preview.conflicts.some((conflict) => /Leave/.test(conflict.reason))).toBe(true);
  });

  it("has nothing to say when nobody is assigned yet", async () => {
    const ticket = await makeTicket();
    const preview = await previewScheduleService({
      ticketId: ticket.id,
      scheduledStart: inDays(3),
    });
    expect(preview.conflicts).toEqual([]);
    expect(preview.crew).toEqual([]);
  });
});

describe("capacity", () => {
  it("reports four weeks of available against committed", async () => {
    const capacity = await capacityService({ weeks: 4 });
    expect(capacity.weeks).toHaveLength(4);
    for (const week of capacity.weeks) {
      expect(week.available).toBeGreaterThanOrEqual(0);
      expect(week.spare).toBe(week.available - week.committed);
    }
  });
});
