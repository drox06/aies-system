import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  determineWarrantyClaimService,
  listWarrantyClaimsService,
  raiseWarrantyClaimService,
  sweepExpiringWarrantiesService,
  upsertEquipmentService,
  warrantyReportService,
} from "@/server/core/operations/warranty-service";
import { WARRANTY_ENTITY_TYPE } from "@/server/core/operations/warranty-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §11, against the real database.
 *
 * §20's named cases: "in-warranty raises a non-billable ticket linked to the original project;
 * out-of-warranty routes to sales; AIES-caused raises an NCR."
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const equipmentIds: string[] = [];
const claimIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `wc-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    permissions: new Set(["warranty.determine", "equipment.manage", "ticket.view"]),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

async function makeAccount(owner: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `WC-${randomUUID().slice(0, 12)}`, name: `WC Co ${suffix}`, ownerId: owner.id },
  });
  accountIds.push(account.id);
  return account;
}

async function makeEquipment(
  actor: AuthedUser,
  accountId: string,
  window: { warrantyStart?: Date | null; warrantyEnd?: Date | null },
) {
  const equipment = await upsertEquipmentService(actorFor(actor), {
    accountId,
    description: `Transmitter ${randomUUID().slice(0, 5)}`,
    modelNumber: "TX-100",
    ...window,
  });
  equipmentIds.push(equipment.id);
  return equipment;
}

const track = <T extends { id: string; resultingTicketId?: string | null }>(claim: T) => {
  claimIds.push(claim.id);
  if (claim.resultingTicketId) ticketIds.push(claim.resultingTicketId);
  return claim;
};

const future = () => new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
const past = () => new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

afterAll(async () => {
  await db.warrantyClaim.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.equipment.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...claimIds, ...equipmentIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§11's three routes", () => {
  /** §20: "in-warranty raises a non-billable ticket linked to the original project". */
  it("raises a non-billable warranty ticket for covered equipment", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: future(),
    });

    const project = await db.project.create({
      data: {
        code: `PRJ-${randomUUID().slice(0, 10)}`,
        name: `Warranty project ${suffix}`,
        accountId: account.id,
        status: "in_progress",
        scopeOfWork: "The original installation this callback comes back on.",
      },
    });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        originalProjectId: project.id,
        faultDescription: "Transmitter reads zero on start-up",
      }),
    );

    expect(claim.number).toMatch(/^AIESWC-\d{6}$/);
    expect(claim.coverage).toBe("in_warranty");
    expect(claim.billable).toBe(false);
    expect(claim.route).toBe("warranty_ticket");
    expect(claim.resultingTicketId).toBeTruthy();

    const ticket = await db.ticket.findUniqueOrThrow({
      where: { id: claim.resultingTicketId! },
    });
    expect(ticket.type).toBe("after_sales");
    expect(ticket.subType).toBe("warranty");
    expect(ticket.billable).toBe(false);
    // §11: "linked to the original project".
    expect(ticket.projectId).toBe(project.id);

    await db.project.delete({ where: { id: project.id } });
  });

  /** §20: "out-of-warranty routes to sales". */
  it("routes an expired customer-caused fault to sales instead of doing it free", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: past(),
    });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Unit run dry after the strainer was removed",
        attribution: "customer_caused",
      }),
    );

    expect(claim.coverage).toBe("out_of_warranty");
    expect(claim.billable).toBe(true);
    expect(claim.route).toBe("sales_quote");
    expect(claim.referToSales).toBe(true);
    expect(claim.resultingTicketId).toBeNull();

    const row = await db.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.salesReferredAt).toBeTruthy();
  });

  /** §20: "AIES-caused raises an NCR" — and the case that proves the two axes are separate. */
  it("keeps an AIES-caused defect free after the warranty has expired, and flags the NCR", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: past(),
    });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Impeller loose — locking compound omitted at installation",
        attribution: "aies_caused",
        rootCauseCategory: "installation_workmanship",
      }),
    );

    expect(claim.coverage).toBe("out_of_warranty");
    expect(claim.billable).toBe(false);
    expect(claim.ncrRequired).toBe(true);
    expect(claim.resultingTicketId).toBeTruthy();

    // Module 08 gets the obligation on the event rather than nobody remembering it.
    const event = await db.eventOutbox.findFirst({
      where: { event: "warranty.claim_raised", actorId: om.id },
    });
    const payload = event?.payload as { ncrRequired?: boolean; rootCauseCategory?: string };
    expect(payload.ncrRequired).toBe(true);
    expect(payload.rootCauseCategory).toBe("installation_workmanship");
  });

  /**
   * The rule the section turns on: an unknown window commits the company to nothing until somebody
   * establishes the terms.
   */
  it("parks a claim on equipment with no recorded window", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, { warrantyEnd: null });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Intermittent trip on start",
      }),
    );

    expect(claim.coverage).toBe("unknown");
    expect(claim.route).toBe("needs_determination");
    expect(claim.resultingTicketId).toBeNull();

    const row = await db.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("open");
    expect(row.salesReferredAt).toBeNull();
  });
});

describe("§11's determination, as a second act", () => {
  it("answers an open claim and raises the ticket then", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, { warrantyEnd: null });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Seal weeping",
      }),
    );
    expect(claim.resultingTicketId).toBeNull();

    const decided = await determineWarrantyClaimService(actorFor(om), {
      id: claim.id,
      coverage: "in_warranty",
      attribution: "undetermined",
      coverageOverrideReason: "Supply contract carries 24 months; certificate located.",
    });

    expect(decided.billable).toBe(false);
    expect(decided.resultingTicketId).toBeTruthy();
    if (decided.resultingTicketId) ticketIds.push(decided.resultingTicketId);

    const row = await db.warrantyClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("routed");
    expect(row.coverageDeterminedById).toBe(om.id);
  });

  /** A person may overrule the dates. Silently is what they may not do. */
  it("refuses to overrule the dates without a reason", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: past(),
    });

    await expect(
      raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Still leaking",
        coverage: "in_warranty",
      }),
    ).rejects.toThrow(/an override nobody explains/);
  });

  it("writes an audit row naming who paid and why", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: future(),
    });

    const claim = track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Display blank",
      }),
    );

    const log = await db.auditLog.findFirst({
      where: {
        entityType: WARRANTY_ENTITY_TYPE,
        entityId: claim.id,
        action: "warranty_claim_raised",
      },
    });
    expect(log?.summary).toMatch(/not billable/);
  });
});

describe("§11's reporting and §16's renewal loop", () => {
  it("separates what the company caused from what it merely carried", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: future(),
    });

    track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Ours",
        attribution: "aies_caused",
        rootCauseCategory: "installation_workmanship",
      }),
    );
    track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Component gave up",
        attribution: "third_party",
      }),
    );

    const report = await warrantyReportService({ accountId: account.id });
    expect(report.total).toBe(2);
    expect(report.aiesCausedCount).toBe(1);
    expect(report.aiesCausedPct).toBe(50);
    expect(report.byProduct[0]!.modelNumber).toBe("TX-100");
  });

  it("lists the claims nobody has answered", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const equipment = await makeEquipment(om, account.id, { warrantyEnd: null });

    track(
      await raiseWarrantyClaimService(actorFor(om), {
        accountId: account.id,
        equipmentId: equipment.id,
        faultDescription: "Unanswered",
      }),
    );

    const read = await listWarrantyClaimsService({ accountId: account.id });
    expect(read.awaitingDetermination).toBe(1);
  });

  it("refuses a warranty that ends before it starts", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);

    await expect(
      upsertEquipmentService(actorFor(om), {
        accountId: account.id,
        description: "Backwards",
        warrantyStart: future(),
        warrantyEnd: past(),
      }),
    ).rejects.toThrow(/ends before it starts/);
  });

  /** §16: a warranty ending is a lead, not a warning. */
  it("emits an expiring warranty for module 01 to pick up", async () => {
    const om = await makeUser("operations_manager");
    const account = await makeAccount(om);
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const equipment = await makeEquipment(om, account.id, {
      warrantyStart: past(),
      warrantyEnd: soon,
    });

    const result = await sweepExpiringWarrantiesService(90);
    expect(result.expiring).toBeGreaterThan(0);

    const event = await db.eventOutbox.findFirst({
      where: {
        event: "warranty.expiring",
        payload: { path: ["equipmentId"], equals: equipment.id },
      },
    });
    expect(event).toBeTruthy();
    await db.eventOutbox.deleteMany({
      where: {
        event: "warranty.expiring",
        payload: { path: ["equipmentId"], equals: equipment.id },
      },
    });
  });
});
