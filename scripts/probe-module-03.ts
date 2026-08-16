import { db } from "../src/lib/db";

/** Read-only: what module 03 has to show on screen right now. */
async function main() {
  const [quotations, customerPos, salesOrders, suppliers, supplierPos, receipts] =
    await Promise.all([
      db.quotation.findMany({
        where: { deletedAt: null },
        select: { number: true, revision: true, status: true, title: true },
        orderBy: { number: "asc" },
      }),
      db.customerPO.findMany({
        where: { deletedAt: null },
        select: { poNumber: true, status: true, quotationId: true },
      }),
      db.salesOrder.findMany({
        where: { deletedAt: null },
        select: { number: true, status: true, procurementStatus: true },
      }),
      db.supplier.count({ where: { deletedAt: null } }),
      db.supplierPO.findMany({
        where: { deletedAt: null },
        select: { number: true, status: true },
      }),
      db.goodsReceipt.count({ where: { deletedAt: null } }),
    ]);

  console.log(`QUOTATIONS (${quotations.length})`);
  for (const q of quotations) {
    console.log(`  ${q.number} r${q.revision}  ${q.status.padEnd(18)} ${q.title}`);
  }

  console.log(`\nCUSTOMER POs (${customerPos.length})`);
  for (const po of customerPos) {
    console.log(
      `  ${po.poNumber.padEnd(14)} ${po.status.padEnd(12)} quotation=${po.quotationId ? "yes" : "none"}`,
    );
  }

  console.log(`\nSALES ORDERS (${salesOrders.length})`);
  for (const so of salesOrders) {
    console.log(`  ${so.number}  ${so.status} / procurement ${so.procurementStatus}`);
  }

  console.log(`\nSUPPLIERS: ${suppliers}`);
  console.log(`SUPPLIER POs (${supplierPos.length})`);
  for (const po of supplierPos) console.log(`  ${po.number}  ${po.status}`);
  console.log(`GOODS RECEIPTS: ${receipts}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
