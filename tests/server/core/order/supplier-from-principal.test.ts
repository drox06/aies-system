import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createPrincipalService,
  transitionPrincipalService,
} from "@/server/core/crm/principal-service";
import { createSupplierFromPrincipalService } from "@/server/core/order/supplier-service";

/**
 * `createSupplierFromPrincipalService` is what `principal.appointed` fires off to, but nothing
 * called it directly until now — `tests/server/core/modules/order-manifest.test.ts` only checks
 * that the manifest *subscribes* to the event, and `principal-flow.test.ts` says outright that the
 * conversion "is tested from module 03's side, not here" because a subscriber runs through the job
 * queue rather than inline. This is that other side.
 *
 * Pinned here specifically: §5c's "no re-keying" promise, now including the two address fields
 * added 2026-09-01 — a converted supplier must carry across what the prospect had typed, not start
 * the head office and plant addresses over from blank.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `sfp-${suffix}`;
const actor = {
  actorId: OWNER,
  actorLabel: "Test",
  permissions: new Set(["principal_prospect.manage", "principal.appoint"]) as ReadonlySet<string>,
};

const prospectIds: string[] = [];
const supplierIds: string[] = [];

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...prospectIds, ...supplierIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.principalProspect.deleteMany({ where: { id: { in: prospectIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

async function makeAppointedProspect() {
  const prospect = await createPrincipalService(actor, {
    companyName: `Appointee ${randomUUID().slice(0, 6)}`,
    country: "Germany",
    headOfficeAddress: { line1: "12 Industriestrasse, Munich" },
    plantAddress: { line1: "Werk 3, Ingolstadt" },
  });
  prospectIds.push(prospect.id);

  for (const stage of ["contacted", "in_discussion", "samples_pricing", "agreement_draft"]) {
    await transitionPrincipalService(actor, { prospectId: prospect.id, to: stage });
  }
  await transitionPrincipalService(actor, {
    prospectId: prospect.id,
    to: "appointed",
    overrideDocuments: "No distributor agreement needed for this test fixture.",
  });

  return prospect;
}

describe("createSupplierFromPrincipalService", () => {
  it("carries the head office and plant addresses across — no re-keying", async () => {
    const prospect = await makeAppointedProspect();

    const { supplierId, created } = await createSupplierFromPrincipalService(actor, prospect.id);
    supplierIds.push(supplierId);
    expect(created).toBe(true);

    const supplier = await db.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    expect(supplier.isPrincipal).toBe(true);
    expect((supplier.address as { line1?: string }).line1).toBe("12 Industriestrasse, Munich");
    expect((supplier.plantAddress as { line1?: string }).line1).toBe("Werk 3, Ingolstadt");
  }, 60_000);

  it("is idempotent — a redelivered event does not create a second supplier", async () => {
    const prospect = await makeAppointedProspect();

    const first = await createSupplierFromPrincipalService(actor, prospect.id);
    supplierIds.push(first.supplierId);
    const second = await createSupplierFromPrincipalService(actor, prospect.id);

    expect(second.supplierId).toBe(first.supplierId);
    expect(second.created).toBe(false);
  }, 60_000);
});
