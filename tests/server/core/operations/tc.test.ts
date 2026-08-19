import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  beginTcService,
  completeTcService,
  recordExternalTcService,
  discardTcService,
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

/**
 * §10's second path — commissioning carried out on an externally written form, already signed.
 *
 * The third of these after §6.2's method statement and §12's service report, and the one where the
 * missing path cost money rather than tidiness: §10's acceptance is what makes the installation
 * milestone billable, so a job commissioned on the customer's own sheet had cleared the real gate
 * while the platform read "nothing recorded" and the milestone stayed unbillable.
 */
describe("an externally written commissioning form", () => {
  async function makeSignedFile(uploader: AuthedUser) {
    return db.fileObject.create({
      data: {
        entityType: TC_ENTITY_TYPE,
        entityId: `pending-${randomUUID()}`,
        filename: "customer-commissioning-sheet.pdf",
        mimeType: "application/pdf",
        size: 4096,
        sha256: randomUUID(),
        storageKey: `test/${randomUUID()}.pdf`,
        uploaderId: uploader.id,
      },
    });
  }

  it("records an accepted commissioning with the signed sheet attached", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const file = await makeSignedFile(engineer);

    const created = await recordExternalTcService(actorFor(engineer), {
      ticketId: ticket.id,
      signedDocumentFileId: file.id,
      customerWitnessName: "R. Santos",
      customerWitnessPosition: "Instrument Engineer",
      completedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const row = await db.testingCommissioning.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.result).toBe("accepted");
    expect(row.completedAt).not.toBeNull();
    expect(row.customerWitnessName).toBe("R. Santos");
    expect(row.certificateFileId).toBe(file.id);
    // Honest about its own provenance: the empty functionalTests are readings on somebody else's
    // sheet, not readings nobody took.
    expect(row.externalDocument).toBe(true);
  });

  /**
   * The one that decides whether an invoice happens.
   *
   * `tc.completed` is what §5's billing subscriber listens for. Emitting it from the worksheet's
   * sign-off and not from here would mean a job commissioned on the customer's form never became
   * billable — the asymmetry that fires for some jobs and not others, in the place it costs most.
   */
  it("emits tc.completed, so the milestone becomes billable either way", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const file = await makeSignedFile(engineer);

    const created = await recordExternalTcService(actorFor(engineer), {
      ticketId: ticket.id,
      signedDocumentFileId: file.id,
      customerWitnessName: "R. Santos",
      completedAt: new Date(Date.now() - 1000),
    });

    const event = await db.eventOutbox.findFirst({
      where: { event: "tc.completed", actorId: engineer.id },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    expect((event!.payload as { testingCommissioningId?: string }).testingCommissioningId).toBe(
      created.id,
    );
  });

  it("refuses an unwitnessed sheet and a date in the future", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const file = await makeSignedFile(engineer);

    await expect(
      recordExternalTcService(actorFor(engineer), {
        ticketId: ticket.id,
        signedDocumentFileId: file.id,
        customerWitnessName: "   ",
        completedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/Name who witnessed/);

    await expect(
      recordExternalTcService(actorFor(engineer), {
        ticketId: ticket.id,
        signedDocumentFileId: file.id,
        customerWitnessName: "R. Santos",
        completedAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow(/finished in the future/);
  });
});

/**
 * Discarding a commissioning started by mistake.
 *
 * "Start commissioning" allocates a number on the first press, so starting one on the wrong ticket
 * is a slip anybody makes. The refusal below is what keeps this from being dangerous.
 */
describe("discarding a commissioning", () => {
  it("removes one that is still in progress, keeping the number used", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const record = await beginTcService(actorFor(engineer), { ticketId: ticket.id });

    await discardTcService(actorFor(engineer), {
      id: record.id,
      reason: "Started on the wrong ticket.",
    });

    const after = await db.testingCommissioning.findUniqueOrThrow({ where: { id: record.id } });
    // Soft, not gone: "what happened to AIESTC-…" has an answer months later, and Spec.md §5
    // forbids reissuing the number.
    expect(after.deletedAt).not.toBeNull();
    expect(
      await db.testingCommissioning.findFirst({ where: { id: record.id, deletedAt: null } }),
    ).toBeNull();
  });

  /**
   * The one that matters. A completed commissioning has fired tc.completed, so §5 may already have
   * made the installation milestone billable and the customer holds a signed certificate. Removing
   * it would leave an invoice standing on nothing.
   */
  it("refuses to remove a completed one, because it has already been billed against", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const file = await db.fileObject.create({
      data: {
        entityType: TC_ENTITY_TYPE,
        entityId: ticket.id,
        filename: "signed.pdf",
        mimeType: "application/pdf",
        size: 1024,
        sha256: randomUUID(),
        storageKey: `test/${randomUUID()}.pdf`,
        uploaderId: engineer.id,
      },
    });
    const created = await recordExternalTcService(actorFor(engineer), {
      ticketId: ticket.id,
      signedDocumentFileId: file.id,
      customerWitnessName: "R. Santos",
      completedAt: new Date(Date.now() - 1000),
    });

    await expect(
      discardTcService(actorFor(engineer), { id: created.id, reason: "Changed my mind about it." }),
    ).rejects.toThrow(/already made the milestone billable/);
  });

  it("refuses a discard with no reason worth reading", async () => {
    const engineer = await makeUser("operations_manager", ["tc.signoff", "ticket.view"]);
    const ticket = await makeTicket(engineer);
    const record = await beginTcService(actorFor(engineer), { ticketId: ticket.id });

    await expect(
      discardTcService(actorFor(engineer), { id: record.id, reason: "oops" }),
    ).rejects.toThrow(/worth reading later/);
  });
});
