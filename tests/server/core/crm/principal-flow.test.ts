import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createPrincipalService,
  linkPrincipalSupplierService,
  sweepPrincipalExpiries,
  transitionPrincipalService,
  updatePrincipalService,
} from "@/server/core/crm/principal-service";

/**
 * specs/01-crm-inquiry.md §5c against the real database.
 *
 * §10 names one case here: "Appointing a principal prospect creates exactly one supplier carrying
 * agreement and price list." Module 03's `Supplier` does not exist, so what is asserted is the half
 * this module owns — that the appointment emits exactly one `principal.appointed` carrying
 * everything the conversion needs, and that linking the resulting supplier is idempotent. The other
 * half is owed by module 03's gate.
 */

const DAY_MS = 86_400_000;
const suffix = randomUUID().slice(0, 8);
const EM = `em-${suffix}`;

/**
 * Carries `principal.appoint` because this file is about §5c's *mechanics* — the stage machine, the
 * event payload, the supplier link — not about who is allowed to appoint. That question got its own
 * rule at the company's request (EA and KJ only) and its own file,
 * tests/server/core/crm/principal-appointment.test.ts, which asserts the refusals.
 *
 * Splitting them is deliberate. Folding the authority check into these tests would mean every
 * assertion about the appointment *event* would also fail the day the permission changed, and the
 * failure would say nothing about which of the two things broke — which is exactly what happened
 * when the permission landed: six red tests here, none of them about permissions.
 */
const actor = {
  actorId: EM,
  actorLabel: "EM Test",
  permissions: new Set(["principal_prospect.manage", "principal.appoint"]) as ReadonlySet<string>,
};

const prospectIds: string[] = [];

async function makeProspect(name?: string) {
  const prospect = await createPrincipalService(actor, {
    companyName: name ?? `Test Instruments ${randomUUID().slice(0, 6)}`,
    country: "Germany",
    productLines: ["Flow meters"],
  });
  prospectIds.push(prospect.id);
  return prospect;
}

/** Walks a prospect to `agreement_draft`, which is where appointment becomes possible. */
async function toAgreementDraft(prospectId: string) {
  for (const stage of ["contacted", "in_discussion", "samples_pricing", "agreement_draft"]) {
    await transitionPrincipalService(actor, { prospectId, to: stage });
  }
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: prospectIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: prospectIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: EM } });
  await db.principalProspect.deleteMany({ where: { id: { in: prospectIds } } });
});

describe("the §5c pipeline, persisted", () => {
  it("starts a new prospect at identified and audits its creation", async () => {
    const prospect = await makeProspect();
    expect(prospect.stage).toBe("identified");

    const audit = await db.auditLog.findFirst({
      where: { entityType: "PrincipalProspect", entityId: prospect.id, action: "create" },
    });
    expect(audit?.summary).toContain(prospect.companyName);
  });

  it("refuses an illegal jump and leaves the stage alone", async () => {
    const prospect = await makeProspect();
    await expect(
      transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/stages are not skipped/);

    const after = await db.principalProspect.findUnique({ where: { id: prospect.id } });
    expect(after?.stage).toBe("identified");
  });

  it("emits principal.stage_changed on every move", async () => {
    const prospect = await makeProspect();
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "contacted" });

    const events = await db.eventOutbox.findMany({
      where: { event: "principal.stage_changed", actorId: EM },
    });
    const mine = events.filter(
      (e) => (e.payload as { prospectId?: string }).prospectId === prospect.id,
    );
    expect(mine).toHaveLength(1);
    expect((mine[0]!.payload as { to?: string }).to).toBe("contacted");
  });
});

describe("appointment (§5c)", () => {
  it("refuses to appoint without an agreement on file, and says what is missing", async () => {
    const prospect = await makeProspect();
    await toAgreementDraft(prospect.id);

    await expect(
      transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/signed distributor agreement.*expiry date/s);
  });

  it("still refuses when the file is attached but the expiry is not", async () => {
    const prospect = await makeProspect();
    await toAgreementDraft(prospect.id);
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      distributorAgreementFileId: "file_agreement",
    });

    await expect(
      transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/expiry date/);
  });

  it("appoints once both are present, and emits exactly one appointment event", async () => {
    const prospect = await makeProspect();
    await toAgreementDraft(prospect.id);
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      distributorAgreementFileId: "file_agreement",
      agreementExpiresAt: new Date(Date.now() + 365 * DAY_MS),
      priceListFileId: "file_pricelist",
      priceListValidUntil: new Date(Date.now() + 180 * DAY_MS),
      exclusivity: "territory",
    });

    const result = await transitionPrincipalService(actor, {
      prospectId: prospect.id,
      to: "appointed",
    });
    expect(result.appointed).toBe(true);

    const events = await db.eventOutbox.findMany({
      where: { event: "principal.appointed", actorId: EM },
    });
    const mine = events.filter(
      (e) => (e.payload as { prospectId?: string }).prospectId === prospect.id,
    );
    // "Exactly one supplier" starts here: exactly one event, or module 03 creates two.
    expect(mine).toHaveLength(1);

    // §5c: "carrying the agreement, price list, and contacts across. No re-keying." The payload has
    // to be sufficient on its own, or module 03 has to go back and re-read.
    const payload = mine[0]!.payload as Record<string, unknown>;
    expect(payload.distributorAgreementFileId).toBe("file_agreement");
    expect(payload.priceListFileId).toBe("file_pricelist");
    expect(payload.exclusivity).toBe("territory");
    expect(payload.isPrincipal).toBe(true);
    expect(payload.agreementExpiresAt).toBeTruthy();
  });

  it("will not appoint twice", async () => {
    const prospect = await makeProspect();
    await toAgreementDraft(prospect.id);
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      distributorAgreementFileId: "file_agreement",
      agreementExpiresAt: new Date(Date.now() + 365 * DAY_MS),
    });
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" });

    await expect(
      transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" }),
    ).rejects.toThrow(/already appointed/);
  });
});

describe("linking the module 03 supplier", () => {
  async function appointed() {
    const prospect = await makeProspect();
    await toAgreementDraft(prospect.id);
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      distributorAgreementFileId: "file_agreement",
      agreementExpiresAt: new Date(Date.now() + 365 * DAY_MS),
    });
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "appointed" });
    return prospect;
  }

  it("records the supplier id, and is idempotent on redelivery", async () => {
    // Module 00's queue guarantees at-least-once delivery, so the same event can arrive twice. A
    // second link with the same id must be a no-op rather than an error or a duplicate.
    const prospect = await appointed();
    const first = await linkPrincipalSupplierService({
      prospectId: prospect.id,
      supplierId: "sup_1",
    });
    expect(first.alreadyLinked).toBe(false);

    const second = await linkPrincipalSupplierService({
      prospectId: prospect.id,
      supplierId: "sup_1",
    });
    expect(second.alreadyLinked).toBe(true);

    const row = await db.principalProspect.findUnique({ where: { id: prospect.id } });
    expect(row?.supplierId).toBe("sup_1");
  });

  it("refuses a second, different supplier — that is the 'exactly one' rule", async () => {
    const prospect = await appointed();
    await linkPrincipalSupplierService({ prospectId: prospect.id, supplierId: "sup_1" });

    await expect(
      linkPrincipalSupplierService({ prospectId: prospect.id, supplierId: "sup_2" }),
    ).rejects.toThrow(/already linked to a different supplier/);
  });

  it("refuses to link a prospect that was never appointed", async () => {
    const prospect = await makeProspect();
    await expect(
      linkPrincipalSupplierService({ prospectId: prospect.id, supplierId: "sup_x" }),
    ).rejects.toThrow(/not appointed/);
  });
});

describe("the nightly expiry sweep (§5c)", () => {
  it("warns the owner on the exact day a threshold is crossed, and not otherwise", async () => {
    const prospect = await makeProspect();
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      // 60 days out is a threshold; 45 is not.
      agreementExpiresAt: new Date(Date.now() + 60 * DAY_MS),
      priceListValidUntil: new Date(Date.now() + 45 * DAY_MS),
    });

    const result = await sweepPrincipalExpiries();
    const mine = result.notified.filter((n) => n.prospectId === prospect.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("agreement");

    const notifications = await db.notification.findMany({
      where: { entityType: "PrincipalProspect", entityId: prospect.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.recipientId).toBe(EM);
  });

  it("warns about a lapsing price list in the language of the risk", async () => {
    const prospect = await makeProspect();
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      priceListValidUntil: new Date(Date.now() + 14 * DAY_MS),
    });

    await sweepPrincipalExpiries();
    const notification = await db.notification.findFirst({
      where: { entityType: "PrincipalProspect", entityId: prospect.id },
    });
    expect(notification?.body).toContain("lapsed prices");
  });

  it("leaves a declined prospect alone", async () => {
    const prospect = await makeProspect();
    await updatePrincipalService(actor, {
      prospectId: prospect.id,
      agreementExpiresAt: new Date(Date.now() + 60 * DAY_MS),
    });
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "declined" });

    const result = await sweepPrincipalExpiries();
    expect(result.notified.map((n) => n.prospectId)).not.toContain(prospect.id);
  });
});
