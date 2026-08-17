import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  firstTimeRightService,
  listQaForTicketService,
  recordQaService,
} from "@/server/core/operations/qa-service";
import { QA_ENTITY_TYPE } from "@/server/core/operations/qa-rules";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import type { TicketType } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §9, against the real database.
 *
 * What only a real run settles:
 *
 *  1. **The evidence block is enforced by the service**, not only by the form — §9 calls it a hard
 *     block, and a rule living in a React component is one a network tab walks past.
 *  2. **The rework loop moves the ticket**, literally back to `in_progress` as the flowchart draws.
 *  3. **The rounds accumulate**, which is what makes first-time-right measurable at all.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const qaIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `qa-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    data: { code: `QA-${randomUUID().slice(0, 12)}`, name: `QA Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);
  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type,
    title: `Inspect ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do the work, then let them look at it.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

const track = <T extends { id: string }>(row: T) => {
  qaIds.push(row.id);
  return row;
};

afterAll(async () => {
  await db.qAApproval.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...qaIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§9's hard block, at the service", () => {
  /** §9: "An unevidenced approval is an assertion." */
  it("refuses an approval with nothing behind it", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);
    const ticket = await makeTicket(om);

    await expect(
      recordQaService(actorFor(om), { ticketId: ticket.id, approved: true }),
    ).rejects.toThrow(/needs the client's own documentation/);

    // And nothing moved: the ticket is where it was.
    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).not.toBe("tc");
  });

  it("accepts an approval backed by the client's document", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);
    const ticket = await makeTicket(om);

    const result = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        evidenceFileIds: ["file-client-signoff"],
        evidenceType: "client_signed_form",
        clientInspectorName: "Plant engineer",
      }),
    );

    expect(result.number).toMatch(/^AIESQA-\d{6}$/);
    expect(result.ticketStatus).toBe("tc");
    expect(result.reworkRound).toBe(0);

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("tc");
  });

  /** §9's answer to the awkward case: weak evidence honestly labelled beats an assertion. */
  it("accepts a written-up verbal approval marked as other", async () => {
    const om = await makeUser("operations_manager", ["qa.record"]);
    const ticket = await makeTicket(om);

    const result = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        evidenceFileIds: ["file-note"],
        evidenceType: "other",
        remarks: "Approved verbally on site by the plant engineer; note written up the same day.",
      }),
    );
    expect(result.ticketStatus).toBe("tc");
  });

  /**
   * §9: "A silently skipped gate and a deliberately waived one look identical in a database unless
   * you make them different."
   */
  it("records a client who did not inspect, and keeps it queryable", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);
    const ticket = await makeTicket(om);

    await expect(
      recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        clientInspected: false,
        evidenceFileIds: ["file-waiver"],
        evidenceType: "other",
      }),
    ).rejects.toThrow(/indistinguishable from one nobody opened/);

    const result = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        clientInspected: false,
        evidenceFileIds: ["file-waiver"],
        evidenceType: "other",
        remarks: "Client waived inspection under the framework agreement.",
      }),
    );

    const row = await db.qAApproval.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.clientInspected).toBe(false);

    // Queryable, which is the whole point of the column.
    const waived = await db.qAApproval.count({
      where: { ticketId: ticket.id, clientInspected: false },
    });
    expect(waived).toBe(1);
  });
});

describe("§9's rework loop, drawn literally", () => {
  it("sends a rejection back to the crew and counts the round", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);
    const ticket = await makeTicket(om);

    const first = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: false,
        defects: [
          { description: "Weld porosity on the north flange", severity: "major" },
          { description: "Touch-up paint", severity: "minor" },
        ],
      }),
    );

    expect(first.ticketStatus).toBe("in_progress");
    expect(first.reworkRound).toBe(1);

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("in_progress");

    // Module 08 gets what it needs to raise the NCR, rather than re-deciding which defects qualify.
    const event = await db.eventOutbox.findFirst({
      where: { event: "qa.failed", actorId: om.id },
    });
    const payload = event?.payload as { ncrWorthy?: { severity: string }[] };
    expect(payload.ncrWorthy).toHaveLength(1);
    expect(payload.ncrWorthy![0]!.severity).toBe("major");
  });

  it("accumulates rounds and then approves", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);
    const ticket = await makeTicket(om);

    track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: false,
        defects: [{ description: "Round one", severity: "minor" }],
      }),
    );
    track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: false,
        defects: [{ description: "Round two", severity: "minor" }],
      }),
    );
    const third = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        evidenceFileIds: ["file-signoff"],
        evidenceType: "client_signed_form",
      }),
    );

    expect(third.reworkRound).toBe(2);
    expect(third.ticketStatus).toBe("tc");

    const read = await listQaForTicketService(ticket.id);
    expect(read.rows).toHaveLength(3);
    expect(read.reworkRounds).toBe(2);
  });

  it("refuses a rejection with nothing for the crew to put right", async () => {
    const om = await makeUser("operations_manager", ["qa.record"]);
    const ticket = await makeTicket(om);

    await expect(
      recordQaService(actorFor(om), { ticketId: ticket.id, approved: false, defects: [] }),
    ).rejects.toThrow(/at least one defect/);
  });
});

describe("§9's metric", () => {
  /** §9: "the quality metric that matters most and is currently unmeasurable." */
  it("counts first-time-right over approvals only", async () => {
    const om = await makeUser("operations_manager", ["qa.record", "ticket.view"]);

    const clean = await makeTicket(om);
    track(
      await recordQaService(actorFor(om), {
        ticketId: clean.id,
        approved: true,
        evidenceFileIds: ["f1"],
        evidenceType: "client_signed_form",
      }),
    );

    const reworked = await makeTicket(om);
    track(
      await recordQaService(actorFor(om), {
        ticketId: reworked.id,
        approved: false,
        defects: [{ description: "Something", severity: "minor" }],
      }),
    );
    track(
      await recordQaService(actorFor(om), {
        ticketId: reworked.id,
        approved: true,
        evidenceFileIds: ["f2"],
        evidenceType: "client_signed_form",
      }),
    );

    // Scoped to these two tickets by reading them back rather than trusting a global rate, which
    // other tests in the suite would move.
    const read = await Promise.all([
      listQaForTicketService(clean.id),
      listQaForTicketService(reworked.id),
    ]);
    expect(read[0]!.rows[0]!.reworkRound).toBe(0);
    expect(read[1]!.rows[0]!.reworkRound).toBe(1);

    const rate = await firstTimeRightService();
    expect(rate.ratePct).not.toBeNull();
  });

  it("writes an audit row naming what the client said", async () => {
    const om = await makeUser("operations_manager", ["qa.record"]);
    const ticket = await makeTicket(om);

    const result = track(
      await recordQaService(actorFor(om), {
        ticketId: ticket.id,
        approved: true,
        evidenceFileIds: ["f1"],
        evidenceType: "client_signed_form",
      }),
    );

    const log = await db.auditLog.findFirst({
      where: { entityType: QA_ENTITY_TYPE, entityId: result.id, action: "qa_approved" },
    });
    expect(log?.summary).toMatch(/client approved the work/);
  });
});
