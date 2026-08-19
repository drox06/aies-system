import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  approveMethodologyService,
  createMethodologyService,
  getMethodologyService,
  listReusableMethodologiesService,
  methodologyGateForTicket,
  overrideMethodologyGateService,
  recordClientDecisionService,
  recordExternalMethodologyService,
  saveMethodologyService,
  submitForInternalReviewService,
  submitToClientService,
  waiveClientApprovalService,
} from "@/server/core/operations/methodology-service";
import { METHODOLOGY_ENTITY_TYPE } from "@/server/core/operations/methodology-rules";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §6.2, against the real database.
 *
 * Three things here cannot be proved by a pure function:
 *
 *  1. **The client's approval demands the document.** §6.2 gates mobilization on the file as well as
 *     the status, so the service must refuse an approval without one — otherwise the record reads
 *     approved while the gate stays shut, which looks like a bug and is the gate being right.
 *  2. **A rejection raises R+1 and leaves the rejected revision alone.** §6.2 calls the chain "the
 *     evidence of what was agreed".
 *  3. **The dates are written by the acts, not typed in.** That is the whole commercial point.
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
      email: `mth-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    data: { code: `MTH-${randomUUID().slice(0, 11)}`, name: `MTH Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);
  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type: "new_project",
    title: `Flowmeter replacement ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Replace two DN100 ultrasonic flowmeters.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

const METHOD = {
  scopeSummary: "Replace two DN100 ultrasonic flowmeters on the raw water line.",
  sequenceOfWork: [
    { step: 1, description: "Isolate and drain", durationHours: 2, crew: "2 techs" },
  ],
  manpowerPlan: [{ role: "Instrument technician", count: 2 }],
  safetyPlan: "Confined space entry permit, gas testing, standby man.",
  toolsRequired: ["Torque wrench"],
  materialsRequired: [{ description: "DN100 gasket set", quantity: "2", unit: "set" }],
};

/** A method statement carried all the way to the client's approval, with their document attached. */
async function approvedMethodology(preparer: AuthedUser, officer: AuthedUser, ticketId: string) {
  const created = await createMethodologyService(actorFor(preparer), {
    ticketId,
    title: `Method statement ${randomUUID().slice(0, 6)}`,
  });
  methodologyIds.push(created.id);

  await saveMethodologyService(actorFor(preparer), { methodologyId: created.id, ...METHOD });
  await submitForInternalReviewService(actorFor(preparer), created.id);
  await approveMethodologyService(actorFor(officer), {
    methodologyId: created.id,
    decision: "approved",
  });
  await submitToClientService(actorFor(preparer), created.id);
  return created;
}

afterAll(async () => {
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...methodologyIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  // Revisions point at their root, so children go first.
  await db.methodology.deleteMany({ where: { parentMethodologyId: { in: methodologyIds } } });
  await db.methodology.deleteMany({ where: { id: { in: methodologyIds } } });
  await db.methodology.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§6.2 — writing one", () => {
  it("allocates a house-format number and starts as R0 draft", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const ticket = await makeTicket(preparer);

    const created = await createMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Flowmeter replacement method statement",
    });
    methodologyIds.push(created.id);

    expect(created.number).toMatch(/^AIESMTH-\d{6}$/);
    expect(created.revision).toBe(0);
  });

  it("will not send a method statement that does not describe a method", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const ticket = await makeTicket(preparer);
    const created = await createMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Empty",
    });
    methodologyIds.push(created.id);

    await expect(submitForInternalReviewService(actorFor(preparer), created.id)).rejects.toThrow(
      /still needs/,
    );
  });

  it("closes editing once it has left AIES", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    await expect(
      saveMethodologyService(actorFor(preparer), {
        methodologyId: created.id,
        scopeSummary: "changed",
      }),
    ).rejects.toThrow(/a change is a revision/);
  });
});

describe("§6.2 — the client", () => {
  it("writes the submission date by the act of sending, and counts the turnaround", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const viewer = await makeUser("operations_manager", ["ticket.view", "methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    const row = await db.methodology.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe("submitted_to_client");
    expect(row.submittedToClientAt).not.toBeNull();

    const read = await getMethodologyService(viewer, created.id);
    expect(read.turnaround.pending).toBe(true);
  });

  /**
   * §6.2 gates mobilization on the document as well as the status. Accepting an approval without one
   * would produce a record that reads approved and a gate that stays shut.
   */
  it("refuses to record the client's approval without their document", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    await expect(
      recordClientDecisionService(actorFor(preparer), {
        methodologyId: created.id,
        decision: "approved",
      }),
    ).rejects.toThrow(/Attach the client's approval/);
  });

  it("records the approval with the document, and clears the gate", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    const blocked = await methodologyGateForTicket(ticket.id);
    expect(blocked.blocks).toBe(true);

    await recordClientDecisionService(actorFor(preparer), {
      methodologyId: created.id,
      decision: "approved",
      approvalFileId: "file-client-approval",
    });

    const cleared = await methodologyGateForTicket(ticket.id);
    expect(cleared.blocks).toBe(false);
    expect(cleared.state).toBe("satisfied");
  });

  /** §6.2: the rejection "creates a revision — the revision chain is the evidence of what was agreed". */
  it("raises R+1 on a rejection and leaves the rejected revision rejected", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare", "ticket.view"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    const result = await recordClientDecisionService(actorFor(preparer), {
      methodologyId: created.id,
      decision: "rejected",
      notes: "Confined space procedure does not match our site rules.",
    });
    expect(result.revisionId).not.toBeNull();

    const rejected = await db.methodology.findUniqueOrThrow({ where: { id: created.id } });
    expect(rejected.status).toBe("client_rejected");
    expect(rejected.clientRejectionNotes).toMatch(/site rules/);

    const revision = await db.methodology.findUniqueOrThrow({ where: { id: result.revisionId! } });
    expect(revision.revision).toBe(1);
    expect(revision.number).toBe(created.number);
    expect(revision.status).toBe("draft");
    // The method is carried across so nobody retypes it; the client's history is not.
    expect(revision.scopeSummary).toBe(METHOD.scopeSummary);
    expect(revision.submittedToClientAt).toBeNull();
    expect(revision.clientRejectionNotes).toBeNull();

    const read = await getMethodologyService(preparer, created.id);
    expect(read.chain).toHaveLength(2);
  });

  it("refuses a rejection with no comments to revise against", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    await expect(
      recordClientDecisionService(actorFor(preparer), {
        methodologyId: created.id,
        decision: "rejected",
      }),
    ).rejects.toThrow(/what the client objected to/);
  });
});

describe("§6.2 — the exception and the override", () => {
  /** "The flag exists only so a rare exception can be recorded, not as a routine setting." */
  it("waives client approval only with a reason, and clears the gate", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const created = await approvedMethodology(preparer, officer, ticket.id);

    await expect(
      waiveClientApprovalService(actorFor(officer), { methodologyId: created.id, reason: "no" }),
    ).rejects.toThrow(/Say why/);

    await waiveClientApprovalService(actorFor(officer), {
      methodologyId: created.id,
      reason: "This utility accepts our standard method statement under the framework agreement.",
    });

    const gate = await methodologyGateForTicket(ticket.id);
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);
  });

  it("logs a gate override with its reason, and refuses one without", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const president = await makeUser("president", ["operations.override_methodology_gate"]);
    const ticket = await makeTicket(preparer);
    await createMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Draft only",
    }).then((m) => methodologyIds.push(m.id));

    await expect(
      overrideMethodologyGateService(actorFor(president), {
        ticketId: ticket.id,
        reason: "urgent",
      }),
    ).rejects.toThrow(/reason somebody can read/);

    await overrideMethodologyGateService(actorFor(president), {
      ticketId: ticket.id,
      reason: "Emergency isolation after a main burst; the client asked us on site verbally.",
    });

    const log = await db.auditLog.findFirst({
      where: {
        entityType: TICKET_ENTITY_TYPE,
        entityId: ticket.id,
        action: "methodology_gate_overridden",
      },
    });
    expect(log?.summary).toMatch(/main burst/);
  });
});

describe("§6.2 — the institutional library", () => {
  it("offers only client-approved method statements, and clones the method not the history", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const officer = await makeUser("operations_manager", ["methodology.approve"]);
    const ticket = await makeTicket(preparer);
    const source = await approvedMethodology(preparer, officer, ticket.id);
    await recordClientDecisionService(actorFor(preparer), {
      methodologyId: source.id,
      decision: "approved",
      approvalFileId: "file-client-approval",
    });

    const reusable = await listReusableMethodologiesService();
    expect(reusable.map((r) => r.id)).toContain(source.id);

    const nextTicket = await makeTicket(preparer);
    const clone = await createMethodologyService(actorFor(preparer), {
      ticketId: nextTicket.id,
      title: "Cloned method statement",
      cloneFromId: source.id,
    });
    methodologyIds.push(clone.id);

    const row = await db.methodology.findUniqueOrThrow({ where: { id: clone.id } });
    expect(row.scopeSummary).toBe(METHOD.scopeSummary);
    expect(row.toolsRequired).toEqual(METHOD.toolsRequired);
    // A fresh document, not a copy of somebody else's agreement.
    expect(row.number).not.toBe(source.number);
    expect(row.status).toBe("draft");
    expect(row.clientApprovalFileId).toBeNull();
    expect(row.submittedToClientAt).toBeNull();
  });

  it("writes an audit row against the method statement", async () => {
    const preparer = await makeUser("technician", ["methodology.prepare"]);
    const ticket = await makeTicket(preparer);
    const created = await createMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Audited",
    });
    methodologyIds.push(created.id);

    const log = await db.auditLog.findFirst({
      where: { entityType: METHODOLOGY_ENTITY_TYPE, entityId: created.id, action: "created" },
    });
    expect(log).not.toBeNull();
  });
});

/**
 * §6.2's second path — the client's own method statement, already approved.
 *
 * The company asked for two ways through this gate: write one here, or record the one the customer
 * wrote and signed. Before it existed, the second case could only go through
 * `overrideMethodologyGateService`, which records "a control was bypassed" — the right words for
 * mobilising *without* a client approval and the wrong ones for mobilising with one.
 *
 * Three things are worth pinning, and the second is the one that keeps this honest rather than
 * convenient.
 */
describe("the client's own method statement", () => {
  async function makeApprovalFile(uploader: AuthedUser) {
    return db.fileObject.create({
      data: {
        entityType: METHODOLOGY_ENTITY_TYPE,
        entityId: `pending-${randomUUID()}`,
        filename: "acme-permit-to-work.pdf",
        mimeType: "application/pdf",
        size: 2048,
        sha256: randomUUID(),
        storageKey: `test/${randomUUID()}.pdf`,
        uploaderId: uploader.id,
      },
    });
  }

  it("clears the gate as an approval, not as an override", async () => {
    const preparer = await makeUser("operations_manager", ["methodology.prepare", "ticket.view"]);
    const ticket = await makeTicket(preparer);
    const file = await makeApprovalFile(preparer);

    const before = await methodologyGateForTicket(ticket.id);
    expect(before.blocks, "a new project with nothing on file must block").toBe(true);

    await recordExternalMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Acme permit to work",
      scopeSummary: "Replace two DN100 flowmeters on the number 2 header.",
      approvalFileId: file.id,
      clientApprovedByName: "R. Santos",
      clientApprovedByPosition: "Maintenance Superintendent",
      clientApprovedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const after = await methodologyGateForTicket(ticket.id);
    // Satisfied through the *existing* rule — status plus document — rather than through any new
    // exception. That is the whole design: one gate, two ways of genuinely meeting it.
    expect(after.blocks).toBe(false);
    expect(after.state).toBe("satisfied");
    expect(after.methodology?.status).toBe("client_approved");
  });

  /**
   * The one that matters.
   *
   * Without this refusal, anybody meeting resistance at internal review could sidestep §6.2's whole
   * chain by declaring the client had approved something — turning a deliberate second path into a
   * hole in the first.
   */
  it("refuses when a method statement is already live on the job", async () => {
    const preparer = await makeUser("operations_manager", ["methodology.prepare", "ticket.view"]);
    const ticket = await makeTicket(preparer);
    const file = await makeApprovalFile(preparer);

    await createMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Ours, in progress",
    });

    await expect(
      recordExternalMethodologyService(actorFor(preparer), {
        ticketId: ticket.id,
        title: "Theirs",
        scopeSummary: "Trying to go around the review.",
        approvalFileId: file.id,
        clientApprovedByName: "R. Santos",
        clientApprovedAt: new Date(),
      }),
    ).rejects.toThrow(/already on this job/);
  });

  it("refuses an approval nobody signed, and one dated in the future", async () => {
    const preparer = await makeUser("operations_manager", ["methodology.prepare", "ticket.view"]);
    const ticket = await makeTicket(preparer);
    const file = await makeApprovalFile(preparer);

    await expect(
      recordExternalMethodologyService(actorFor(preparer), {
        ticketId: ticket.id,
        title: "Theirs",
        scopeSummary: "Covered.",
        approvalFileId: file.id,
        clientApprovedByName: "   ",
        clientApprovedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/Name who signed it/);

    await expect(
      recordExternalMethodologyService(actorFor(preparer), {
        ticketId: ticket.id,
        title: "Theirs",
        scopeSummary: "Covered.",
        approvalFileId: file.id,
        clientApprovedByName: "R. Santos",
        clientApprovedAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow(/signed it in the future/);
  });

  /** The record must not pretend AIES wrote it. */
  it("marks the record as somebody else's document", async () => {
    const preparer = await makeUser("operations_manager", ["methodology.prepare", "ticket.view"]);
    const ticket = await makeTicket(preparer);
    const file = await makeApprovalFile(preparer);

    const created = await recordExternalMethodologyService(actorFor(preparer), {
      ticketId: ticket.id,
      title: "Acme permit to work",
      scopeSummary: "Replace two DN100 flowmeters.",
      approvalFileId: file.id,
      clientApprovedByName: "R. Santos",
      clientApprovedByPosition: "Maintenance Superintendent",
      clientApprovedAt: new Date(Date.now() - 1000),
    });

    const row = await db.methodology.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.externalDocument).toBe(true);
    expect(row.clientApprovedByName).toBe("R. Santos");
    expect(row.clientApprovalFileId).toBe(file.id);
    // No submission ever happened, so the turnaround figure must not claim one did.
    expect(row.submittedToClientAt).toBeNull();
  });
});
