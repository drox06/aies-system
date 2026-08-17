import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  beginTcService,
  completeTcService,
  listTcForTicketService,
  promisedLinesForTicketService,
  saveTcService,
} from "@/server/core/operations/tc-service";
import { TC_ENTITY_TYPE, type FunctionalTest } from "@/server/core/operations/tc-rules";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §10, against the real database.
 *
 * What only a real run settles:
 *
 *  1. **The server stamps provenance**, and ignores what the caller claims about it — the whole of
 *     what makes §10's out-of-spec flag mean anything (docs/DECISIONS.md #69).
 *  2. **The completion rules are enforced at the service**, not only in the form.
 *  3. **The ticket moves**, and a critical punch item raises its own event for §12.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const tcIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `tc-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    data: { code: `TC-${randomUUID().slice(0, 12)}`, name: `TC Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);
  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type: "installation",
    title: `Commission ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Install it, then prove it works.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

async function openTc(user: AuthedUser) {
  const ticket = await makeTicket(user);
  const record = await beginTcService(actorFor(user), { ticketId: ticket.id });
  tcIds.push(record.id);
  return { ticket, record };
}

const loopTest: FunctionalTest = {
  test: "Loop 4-20mA output",
  criterion: { kind: "range", min: 4, max: 20 },
  criterionSource: "quotation",
  quotationLineId: "ql-fixture",
  promiseText: "Transmitter, 4-20mA output",
};

afterAll(async () => {
  await db.testingCommissioning.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...tcIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§10's provenance, stamped by the server", () => {
  /**
   * The integrity test. A caller that could post its own `criterionSetAt` could claim the limit was
   * written last week, and a provenance field anybody can write is decoration.
   */
  it("ignores a criterionSetAt the caller supplies", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { record } = await openTc(om);

    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [
        {
          ...loopTest,
          criterionSetAt: "2020-01-01T00:00:00.000Z",
          criterionSetById: "somebody-else",
          measured: 12,
        },
      ],
    });

    const saved = await db.testingCommissioning.findUniqueOrThrow({ where: { id: record.id } });
    const tests = saved.functionalTests as unknown as FunctionalTest[];
    expect(tests[0]!.criterionSetAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(tests[0]!.criterionSetById).toBe(om.id);
    expect(new Date(tests[0]!.criterionSetAt!).getFullYear()).toBeGreaterThan(2020);
  });

  /** A criterion fixed in an earlier save is a criterion the reading could not be fitted to. */
  it("keeps the criterion's original timestamp when a later save only adds the reading", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute"]);
    const { record } = await openTc(om);

    await saveTcService(actorFor(om), { id: record.id, functionalTests: [loopTest] });
    const first = (await db.testingCommissioning.findUniqueOrThrow({ where: { id: record.id } }))
      .functionalTests as unknown as FunctionalTest[];

    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 12 }],
    });
    const second = (await db.testingCommissioning.findUniqueOrThrow({ where: { id: record.id } }))
      .functionalTests as unknown as FunctionalTest[];

    expect(second[0]!.criterionSetAt).toBe(first[0]!.criterionSetAt);
    expect(second[0]!.measuredAt).toBeTruthy();
    // The reading came after the limit, which is the ordering §10 is really asking about.
    expect(new Date(second[0]!.measuredAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(second[0]!.criterionSetAt!).getTime(),
    );
  });

  /** Names are the key results stay attached to, so two tests cannot share one. */
  it("refuses two tests with the same name", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute"]);
    const { record } = await openTc(om);

    await expect(
      saveTcService(actorFor(om), {
        id: record.id,
        functionalTests: [loopTest, { ...loopTest, measured: 99 }],
      }),
    ).rejects.toThrow(/Names are how results stay attached/);
  });

  it("gives one open record per ticket rather than a new one each time", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute"]);
    const { ticket, record } = await openTc(om);
    const again = await beginTcService(actorFor(om), { ticketId: ticket.id });
    expect(again.id).toBe(record.id);
  });
});

describe("§10's completion rules, at the service", () => {
  it("refuses a clean acceptance over an out-of-spec reading", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { record } = await openTc(om);
    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 25 }],
      calibrationAssetsUsed: ["FLUKE-744"],
    });

    await expect(
      completeTcService(actorFor(om), {
        id: record.id,
        result: "accepted",
        customerSignatureFileId: "file-sig",
      }),
    ).rejects.toThrow(/cannot be recorded as a clean acceptance/);
  });

  /** §10's certificate is a billing trigger, so it carries the customer's signature. */
  it("refuses a sign-off with neither a signature nor a reason there is none", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { record } = await openTc(om);
    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 12 }],
      calibrationAssetsUsed: ["FLUKE-744"],
    });

    await expect(
      completeTcService(actorFor(om), { id: record.id, result: "accepted" }),
    ).rejects.toThrow(/customer's signature, or a written reason/);

    const signed = await completeTcService(actorFor(om), {
      id: record.id,
      result: "accepted",
      customerSignatureFileId: "file-sig",
    });
    expect(signed.number).toMatch(/^AIESTC-\d{6}$/);
    expect(signed.ticketStatus).toBe("for_closeout");
  });

  it("will not complete the same record twice", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { record } = await openTc(om);
    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 12 }],
    });
    await completeTcService(actorFor(om), {
      id: record.id,
      result: "accepted",
      customerSignatureFileId: "file-sig",
    });

    await expect(
      completeTcService(actorFor(om), {
        id: record.id,
        result: "accepted",
        customerSignatureFileId: "file-sig",
      }),
    ).rejects.toThrow(/already completed/);

    await expect(
      saveTcService(actorFor(om), { id: record.id, functionalTests: [loopTest] }),
    ).rejects.toThrow(/is completed/);
  });
});

describe("§10's outcome, on the ticket", () => {
  it("carries an out-of-spec reading onto the punch list and raises it for close-out", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { ticket, record } = await openTc(om);

    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 25 }],
      punchItems: [
        { description: "Recalibrate transmitter", severity: "critical", ownerId: om.id },
        { description: "Touch-up paint", severity: "minor" },
      ],
      calibrationAssetsUsed: ["FLUKE-744"],
    });

    const done = await completeTcService(actorFor(om), {
      id: record.id,
      result: "accepted_with_punch",
      customerSignatureFileId: "file-sig",
    });

    expect(done.ticketStatus).toBe("for_closeout");
    expect(done.closeoutBlockers).toBe(1);

    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("for_closeout");

    // §12 and module 08 learn about the blocker from an event rather than by re-reading this record.
    const raised = await db.eventOutbox.findFirst({
      where: { event: "punch_item.raised", actorId: om.id },
    });
    const payload = raised?.payload as { items?: { severity: string }[] };
    expect(payload.items).toHaveLength(1);
    expect(payload.items![0]!.severity).toBe("critical");

    const completed = await db.eventOutbox.findFirst({
      where: { event: "tc.completed", actorId: om.id },
    });
    expect((completed?.payload as { result?: string }).result).toBe("accepted_with_punch");
  });

  it("loops a rejection back to the crew", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { ticket, record } = await openTc(om);

    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 25 }],
      calibrationAssetsUsed: ["FLUKE-744"],
    });

    const done = await completeTcService(actorFor(om), {
      id: record.id,
      result: "rejected",
      customerSignatureFileId: "file-sig",
    });

    expect(done.ticketStatus).toBe("in_progress");
    const after = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("in_progress");
  });

  it("writes an audit row naming what was commissioned", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { record } = await openTc(om);
    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 12 }],
    });
    await completeTcService(actorFor(om), {
      id: record.id,
      result: "accepted",
      customerSignatureFileId: "file-sig",
    });

    const log = await db.auditLog.findFirst({
      where: { entityType: TC_ENTITY_TYPE, entityId: record.id, action: "tc_completed" },
    });
    expect(log?.summary).toMatch(/commissioning accepted/);
  });
});

describe("§10's reading side", () => {
  it("reports the open punch items and which of them block close-out", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute", "tc.signoff"]);
    const { ticket, record } = await openTc(om);

    await saveTcService(actorFor(om), {
      id: record.id,
      functionalTests: [{ ...loopTest, measured: 12 }],
      punchItems: [
        { description: "Earth bond", severity: "critical", ownerId: om.id },
        { description: "Already done", severity: "critical", status: "closed" },
        { description: "Paint", severity: "minor" },
      ],
    });
    await completeTcService(actorFor(om), {
      id: record.id,
      result: "accepted_with_punch",
      customerSignatureFileId: "file-sig",
    });

    const read = await listTcForTicketService(ticket.id);
    expect(read.rows).toHaveLength(1);
    expect(read.openPunchItems).toHaveLength(2); // the closed critical drops out
    expect(read.closeoutBlockers).toHaveLength(1);
    expect(read.closeoutBlockers[0]!.description).toBe("Earth bond");
  });

  /**
   * §10 wants criteria read from the accepted quotation. A standalone ticket has no sales order
   * behind it, and the screen says so rather than offering an empty picker.
   */
  it("says plainly when a ticket has no promised lines to cite", async () => {
    const om = await makeUser("operations_manager", ["ticket.execute"]);
    const ticket = await makeTicket(om);
    const promised = await promisedLinesForTicketService(ticket.id);
    expect(promised.lines).toHaveLength(0);
    expect(promised.note).toMatch(/not linked to a sales order/);
  });
});
