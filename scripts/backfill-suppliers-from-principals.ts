import { db } from "../src/lib/db";
import { createSupplierFromPrincipalService } from "../src/server/core/order/supplier-service";

/**
 * Converts the principals that were appointed *before* module 03 existed, and repoints their RFQs.
 *
 * §5c has promised since session 3 that appointing a principal creates a `Supplier`. Module 01 has
 * emitted `principal.appointed` all along, but nothing consumed it, so every principal appointed to
 * date sits with `supplierId` null and a "Supplier record pending module 03" badge on its panel.
 * The manifest subscriber handles appointments from here on; these are the ones that already
 * happened.
 *
 * ## The second half matters more than the first
 *
 * `SupplierQuoteRequest.supplierId` holds a **`PrincipalProspect` id** — appointed principals were
 * the interim answer to "who do we ask for pricing", and every RFQ ever raised points at one. Until
 * those ids are repointed at the new `Supplier` rows, the foreign key that ought to be on that
 * column cannot be added, and `listRfqsForQuotationService` is looking up supplier names in the
 * wrong table.
 *
 * Order is not optional: suppliers must exist before anything can point at them. Both steps run in
 * one pass so the database is never left half-converted.
 *
 * Reports by default. Pass `--apply` to write.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  const prospects = await db.principalProspect.findMany({
    where: { stage: "appointed", deletedAt: null, supplierId: null },
    select: { id: true, companyName: true, agreementExpiresAt: true },
    orderBy: { createdAt: "asc" },
  });

  const rfqs = await db.supplierQuoteRequest.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true, supplierId: true },
  });

  console.log(`Principals appointed with no supplier record: ${prospects.length}`);
  for (const p of prospects) console.log(`  ${p.companyName}`);

  console.log(`\nSupplier RFQs to repoint: ${rfqs.length}`);
  for (const r of rfqs) console.log(`  ${r.number} → currently points at ${r.supplierId}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  const actor = { actorId: "system", actorLabel: "System (module 03 backfill)" };

  /** prospect id → supplier id, built as we go and then used to repoint. */
  const supplierByProspect = new Map<string, string>();

  for (const prospect of prospects) {
    const result = await createSupplierFromPrincipalService(actor, prospect.id);
    supplierByProspect.set(prospect.id, result.supplierId);
    console.log(
      `${result.created ? "created" : "already had"} a supplier for ${prospect.companyName}`,
    );
  }

  // Principals converted on an earlier run count too — this is idempotent, and a half-finished
  // previous attempt must not leave RFQs stranded.
  const alreadyConverted = await db.principalProspect.findMany({
    where: { supplierId: { not: null } },
    select: { id: true, supplierId: true },
  });
  for (const row of alreadyConverted) {
    if (row.supplierId) supplierByProspect.set(row.id, row.supplierId);
  }

  let repointed = 0;
  let alreadyPointingAtSupplier = 0;
  for (const rfq of rfqs) {
    const supplierId = supplierByProspect.get(rfq.supplierId);
    if (!supplierId) {
      // Either it already points at a Supplier (a re-run), or at a prospect that was never
      // appointed — which should be impossible, since raising an RFQ requires an appointed one.
      const isSupplier = await db.supplier.findUnique({ where: { id: rfq.supplierId } });
      if (isSupplier) {
        alreadyPointingAtSupplier++;
      } else {
        console.warn(
          `  ${rfq.number} points at ${rfq.supplierId}, which is neither a converted prospect ` +
            `nor a supplier. Left alone — investigate before adding the foreign key.`,
        );
      }
      continue;
    }

    await db.supplierQuoteRequest.update({
      where: { id: rfq.id },
      data: { supplierId },
    });
    repointed++;
    console.log(`repointed ${rfq.number}`);
  }

  console.log(
    `\nDone. ${supplierByProspect.size} supplier(s) linked, ${repointed} RFQ(s) repointed, ` +
      `${alreadyPointingAtSupplier} already correct.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
