import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  listProgressService,
  logDayService,
  standbyEvidenceService,
  stepsForTicketService,
} from "@/server/core/operations/daily-progress-service";
import { DAILY_PROGRESS_ENTITY_TYPE } from "@/server/core/operations/daily-progress-rules";
import {
  createMethodologyService,
  saveMethodologyService,
} from "@/server/core/operations/methodology-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import type { TicketType } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §8's execution half, against the real database.
 *
 * Two claims a pure function cannot settle:
 *
 *  1. **One log per day, corrected rather than duplicated.** Two accounts of one day, written by
 *     whoever was nearest the phone, make the claim built on them worthless. The unique index is the
 *     design; this proves the service upserts against it.
 *  2. **The steps come from the method statement**, so a percentage can be traced back to a step.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const methodologyIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `dp-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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

async function makeTicket(lead: AuthedUser, type: TicketType = "installation") {
  const account = await db.customerAccount.create({
    data: { code: `DP-${randomUUID().slice(0, 12)}`, name: `DP Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);
  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type,
    title: `Execute ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do the work.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

const DAY = (n: number) => new Date(Date.UTC(2026, 7, n));

afterAll(async () => {
  await db.dailyProgress.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.methodology.deleteMany({ where: { id: { in: methodologyIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...ticketIds, ...accountIds, ...methodologyIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§8 — one log per day", () => {
  it("files a day and reads it back", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const ticket = await makeTicket(tech);

    const result = await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 25,
      manpowerOnSite: 3,
      hoursWorked: 8,
      stepsCompleted: [1],
    });
    expect(result.corrected).toBe(false);

    const read = await listProgressService(ticket.id);
    expect(read.rows).toHaveLength(1);
    expect(read.percentComplete).toBe(25);
  });

  /**
   * Two accounts of one day would disagree, and the claim built on them would be worthless. Saving
   * the same date again is a correction, not a second entry.
   */
  it("corrects the same day rather than filing a second one", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const ticket = await makeTicket(tech);

    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 25,
      manpowerOnSite: 3,
      hoursWorked: 8,
    });
    const second = await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 35,
      manpowerOnSite: 4,
      hoursWorked: 9,
    });

    expect(second.corrected).toBe(true);
    const read = await listProgressService(ticket.id);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.percentComplete).toBe(35);

    // The correction is in the trail, so the first version is not silently gone.
    const log = await db.auditLog.findFirst({
      where: { entityType: DAILY_PROGRESS_ENTITY_TYPE, action: "corrected", actorId: tech.id },
    });
    expect(log).not.toBeNull();
  });

  it("normalises the day, so a late-evening entry does not land on the wrong date", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const ticket = await makeTicket(tech);

    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: new Date(Date.UTC(2026, 7, 12, 23, 45)),
      percentComplete: 10,
      manpowerOnSite: 1,
      hoursWorked: 2,
    });
    const again = await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: new Date(Date.UTC(2026, 7, 12, 6, 0)),
      percentComplete: 15,
      manpowerOnSite: 1,
      hoursWorked: 3,
    });

    expect(again.corrected).toBe(true);
    expect((await listProgressService(ticket.id)).rows).toHaveLength(1);
  });

  it("refuses standby with no cause, at the service and not only in the form", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);

    await expect(
      logDayService(actorFor(tech), {
        ticketId: ticket.id,
        logDate: DAY(10),
        percentComplete: 10,
        manpowerOnSite: 2,
        hoursWorked: 4,
        standbyHours: 4,
      }),
    ).rejects.toThrow(/Standby hours need a cause/);
  });

  it("returns the warnings rather than refusing a messy day", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);

    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 50,
      manpowerOnSite: 2,
      hoursWorked: 8,
    });
    const backwards = await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(11),
      percentComplete: 40,
      manpowerOnSite: 2,
      hoursWorked: 8,
    });

    expect(backwards.warnings.join(" ")).toMatch(/gone backwards/);
  });
});

describe("§8 — logging against the method statement", () => {
  /** §8: "daily progress logging **against the methodology's sequence of work**." */
  it("offers the method statement's steps to tick", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "methodology.prepare"]);
    const ticket = await makeTicket(tech, "new_project");

    const methodology = await createMethodologyService(actorFor(tech), {
      ticketId: ticket.id,
      title: "Method",
    });
    methodologyIds.push(methodology.id);
    await saveMethodologyService(actorFor(tech), {
      methodologyId: methodology.id,
      sequenceOfWork: [
        { step: 1, description: "Isolate and drain", durationHours: 2, crew: "2" },
        { step: 2, description: "Remove the old meter", durationHours: 3, crew: "2" },
      ],
    });

    const result = await stepsForTicketService(ticket.id);
    expect(result.methodology?.number).toBe(methodology.number);
    expect(result.steps.map((s) => s.description)).toEqual([
      "Isolate and drain",
      "Remove the old meter",
    ]);
  });

  /** An after-sales callout usually has none, and the screen should say so rather than pretend. */
  it("returns an empty list when there is no method statement", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech, "after_sales");

    const result = await stepsForTicketService(ticket.id);
    expect(result.methodology).toBeNull();
    expect(result.steps).toEqual([]);
  });
});

describe("§8's evidence base, end to end", () => {
  /**
   * §8: "This is the evidence base for a variation claim, and today it exists only in people's
   * memory."
   */
  it("totals the customer's delays separately from ours", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const ticket = await makeTicket(tech);

    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 10,
      manpowerOnSite: 3,
      hoursWorked: 4,
      standbyHours: 4,
      standbyCause: "client_not_ready",
      standbyNotes: "Plant would not release the line.",
    });
    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(11),
      percentComplete: 25,
      manpowerOnSite: 3,
      hoursWorked: 6,
      standbyHours: 2,
      standbyCause: "equipment_failure",
    });

    const evidence = await standbyEvidenceService({ ticketId: ticket.id });
    expect(evidence.summary.customerCausedHours).toBe(4);
    expect(evidence.summary.aiesCausedHours).toBe(2);

    // Only the days something went wrong: a claim is read line by line.
    expect(evidence.days).toHaveLength(2);
    expect(evidence.days[0]!.notes).toMatch(/would not release/);
  });

  it("refuses to total standby across the whole company", async () => {
    await expect(standbyEvidenceService({})).rejects.toThrow(/not a claim/);
  });

  it("writes an audit row against the log", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);

    await logDayService(actorFor(tech), {
      ticketId: ticket.id,
      logDate: DAY(10),
      percentComplete: 5,
      manpowerOnSite: 1,
      hoursWorked: 2,
    });

    const log = await db.auditLog.findFirst({
      where: { entityType: DAILY_PROGRESS_ENTITY_TYPE, action: "logged", actorId: tech.id },
    });
    expect(log?.summary).toMatch(/5% complete/);
  });
});
