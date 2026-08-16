import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createPrincipalService,
  deletePrincipalService,
  overridePrincipalStageService,
  transitionPrincipalService,
} from "@/server/core/crm/principal-service";
import { PRINCIPAL_ENTITY_TYPE } from "@/server/core/crm/principal-lifecycle";
import { deleteSupplierService } from "@/server/core/order/supplier-service";

/**
 * The President's corrections, asked for by the company on 2026-08-16.
 *
 * §5c's stage machine is forward-only, which is right for the ordinary path and leaves a stage
 * entered by mistake permanent. These are the way back and the way out — both reserved to the
 * President, both demanding a reason, and both refusing when something downstream would be left
 * pointing at nothing.
 */

const suffix = randomUUID().slice(0, 8);
const EA = `ea-${suffix}`;
const actor = {
  actorId: EA,
  actorLabel: "EA (president)",
  permissions: new Set(["principal_prospect.manage", "principal.appoint"]) as ReadonlySet<string>,
};

const prospectIds: string[] = [];
const supplierIds: string[] = [];

async function makeProspect() {
  const prospect = await createPrincipalService(actor, {
    companyName: `Correctable ${randomUUID().slice(0, 6)}`,
    country: "Japan",
    productLines: ["Valves"],
  });
  prospectIds.push(prospect.id);
  return prospect;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...prospectIds, ...supplierIds] } } });
  await db.notification.deleteMany({ where: { entityId: { in: prospectIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: EA } });
  await db.principalProspect.deleteMany({ where: { id: { in: prospectIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

describe("setting a stage by hand", () => {
  it("goes backwards, which the ordinary machine refuses", async () => {
    const prospect = await makeProspect();
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "contacted" });
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: "in_discussion" });

    // The state machine has no reverse gear — that is the thing being worked around.
    await expect(
      transitionPrincipalService(actor, { prospectId: prospect.id, to: "contacted" }),
    ).rejects.toThrow();

    const corrected = await overridePrincipalStageService(actor, {
      prospectId: prospect.id,
      to: "contacted",
      reason: "Logged at the wrong stage after the trade show.",
    });
    expect(corrected.stage).toBe("contacted");
  }, 60_000);

  it("skips stages, which the ordinary machine also refuses", async () => {
    const prospect = await makeProspect();
    const corrected = await overridePrincipalStageService(actor, {
      prospectId: prospect.id,
      to: "agreement_draft",
      reason: "Migrated from the old spreadsheet; the earlier stages happened off-system.",
    });
    expect(corrected.stage).toBe("agreement_draft");
  }, 60_000);

  it("demands a reason, and refuses a stage that does not exist", async () => {
    const prospect = await makeProspect();

    await expect(
      overridePrincipalStageService(actor, {
        prospectId: prospect.id,
        to: "contacted",
        reason: "",
      }),
    ).rejects.toThrow(/Say why/);

    await expect(
      overridePrincipalStageService(actor, {
        prospectId: prospect.id,
        to: "negotiating",
        reason: "A stage somebody invented.",
      }),
    ).rejects.toThrow(/is not a stage/);
  }, 60_000);

  it("writes the correction to the audit trail in words", async () => {
    const prospect = await makeProspect();
    await overridePrincipalStageService(actor, {
      prospectId: prospect.id,
      to: "samples_pricing",
      reason: "Samples arrived last month; the record was never moved.",
    });

    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        entityType: PRINCIPAL_ENTITY_TYPE,
        entityId: prospect.id,
        action: "stage_overridden",
      },
    });
    expect(audit.summary).toMatch(/outside §5c's stage order/);
    expect(audit.summary).toContain("Samples arrived last month");
  }, 60_000);

  it("does not emit principal.stage_changed", async () => {
    // Subscribers treat that event as the pipeline moving. A correction is somebody fixing the
    // record — and an override into `appointed` firing it would create a supplier behind the
    // officers' backs, which is the one decision §5c reserves to them.
    const prospect = await makeProspect();
    await overridePrincipalStageService(actor, {
      prospectId: prospect.id,
      to: "appointed",
      reason: "Appointed years ago; this record is a backfill.",
    });

    const events = await db.eventOutbox.findMany({
      where: {
        event: { in: ["principal.stage_changed", "principal.appointed"] },
        payload: { path: ["prospectId"], equals: prospect.id },
      },
    });
    expect(events).toEqual([]);
  }, 60_000);
});

describe("deleting a prospect", () => {
  it("soft-deletes it, with a reason on the record", async () => {
    const prospect = await makeProspect();
    const deleted = await deletePrincipalService(actor, {
      prospectId: prospect.id,
      reason: "Duplicate of an existing prospect.",
    });

    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedBy).toBe(EA);
    // Spec.md §5: soft delete. The row survives; it just leaves every list.
    const stored = await db.principalProspect.findUnique({ where: { id: prospect.id } });
    expect(stored).not.toBeNull();
  }, 60_000);

  it("demands a reason", async () => {
    const prospect = await makeProspect();
    await expect(
      deletePrincipalService(actor, { prospectId: prospect.id, reason: "  " }),
    ).rejects.toThrow(/never whether it was deleted but why/);
  }, 60_000);

  it("refuses once it has been converted into a supplier", async () => {
    // The conversion is §5c's whole promise, and the supplier is a live record other modules point
    // at. Deleting the prospect would leave it with no account of where it came from.
    const prospect = await makeProspect();
    const supplier = await db.supplier.create({
      data: { code: `CORR-${randomUUID().slice(0, 8)}`, name: "Converted", isPrincipal: true },
    });
    supplierIds.push(supplier.id);
    await db.principalProspect.update({
      where: { id: prospect.id },
      data: { supplierId: supplier.id },
    });

    await expect(
      deletePrincipalService(actor, { prospectId: prospect.id, reason: "Tidying up." }),
    ).rejects.toThrow(/delete the supplier first/i);
  }, 60_000);

  it("becomes deletable once the supplier is removed, which also unlinks it", async () => {
    const prospect = await makeProspect();
    const supplier = await db.supplier.create({
      data: {
        code: `CORR-${randomUUID().slice(0, 8)}`,
        name: "Converted twice",
        isPrincipal: true,
      },
    });
    supplierIds.push(supplier.id);
    await db.principalProspect.update({
      where: { id: prospect.id },
      data: { supplierId: supplier.id },
    });

    await deleteSupplierService(actor, {
      supplierId: supplier.id,
      reason: "Created from a prospect that should not have been appointed.",
    });

    // Clearing `supplierId` matters beyond this test: it is the guard that makes the conversion
    // idempotent, and leaving it set would make the prospect permanently unconvertible.
    const unlinked = await db.principalProspect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(unlinked.supplierId).toBeNull();

    const deleted = await deletePrincipalService(actor, {
      prospectId: prospect.id,
      reason: "Was appointed in error; the supplier has been removed.",
    });
    expect(deleted.deletedAt).not.toBeNull();
  }, 60_000);
});

describe("deleting a supplier", () => {
  it("refuses while a price request still points at it", async () => {
    const supplier = await db.supplier.create({
      data: { code: `CORR-${randomUUID().slice(0, 8)}`, name: "Has an RFQ" },
    });
    supplierIds.push(supplier.id);
    const rfq = await db.supplierQuoteRequest.create({
      data: {
        number: `CORRRFQ-${randomUUID().slice(0, 6)}`,
        supplierId: supplier.id,
        requestBody: "Please quote.",
        requestedById: EA,
      },
    });

    await expect(
      deleteSupplierService(actor, { supplierId: supplier.id, reason: "No longer used." }),
    ).rejects.toThrow(/price request/);

    await db.supplierQuoteRequest.delete({ where: { id: rfq.id } });
  }, 60_000);

  it("points at withdrawing the clause 8.4 approval instead", async () => {
    // The useful alternative, in the message: "should not be bought from" and "should not exist"
    // are different requests, and only one of them is a delete.
    const supplier = await db.supplier.create({
      data: { code: `CORR-${randomUUID().slice(0, 8)}`, name: "Still referenced" },
    });
    supplierIds.push(supplier.id);
    const rfq = await db.supplierQuoteRequest.create({
      data: {
        number: `CORRRFQ-${randomUUID().slice(0, 6)}`,
        supplierId: supplier.id,
        requestBody: "Please quote.",
        requestedById: EA,
      },
    });

    await expect(
      deleteSupplierService(actor, { supplierId: supplier.id, reason: "Tidying." }),
    ).rejects.toThrow(/Withdraw its clause 8\.4 approval instead/);

    await db.supplierQuoteRequest.delete({ where: { id: rfq.id } });
  }, 60_000);

  it("deletes one nothing points at", async () => {
    const supplier = await db.supplier.create({
      data: { code: `CORR-${randomUUID().slice(0, 8)}`, name: "Typo Ltd" },
    });
    supplierIds.push(supplier.id);

    const deleted = await deleteSupplierService(actor, {
      supplierId: supplier.id,
      reason: "Duplicate, created by mistake.",
    });
    expect(deleted.deletedAt).not.toBeNull();
  }, 60_000);
});
