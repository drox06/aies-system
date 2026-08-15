import { db } from "../src/lib/db";

/** Read-only: the supplier directory, and whether the RFQ cutover landed correctly. */
async function main() {
  const suppliers = await db.supplier.findMany({
    where: { deletedAt: null },
    include: { principalProspect: { select: { companyName: true, stage: true } } },
    orderBy: { code: "asc" },
  });

  console.log(`SUPPLIERS (${suppliers.length})`);
  for (const s of suppliers) {
    console.log(
      `  ${s.code.padEnd(10)} ${s.name.padEnd(24)} principal=${s.isPrincipal} approved=${s.isApproved}` +
        (s.principalProspect ? ` ← prospect "${s.principalProspect.companyName}"` : ""),
    );
  }

  const rfqs = await db.supplierQuoteRequest.findMany({
    where: { deletedAt: null },
    include: { supplier: { select: { code: true, name: true } } },
  });
  console.log(`\nRFQs (${rfqs.length})`);
  for (const r of rfqs) {
    // Resolving through the relation is the proof: before the cutover this join found nothing.
    console.log(`  ${r.number} → ${r.supplier.code} ${r.supplier.name}`);
  }

  const orphanProspects = await db.principalProspect.count({
    where: { stage: "appointed", deletedAt: null, supplierId: null },
  });
  console.log(`\nAppointed principals still without a supplier record: ${orphanProspects}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
