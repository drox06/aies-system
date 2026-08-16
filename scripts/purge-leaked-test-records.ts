import { db } from "../src/lib/db";

/**
 * Removes records left behind by test runs against the development database.
 *
 * Tests share the company's dev database (there is no separate test database — that was tried and
 * reverted), so a test that forgets to clean up leaves a real row behind. `customer-po.test.ts` did
 * exactly that for months: walking an inquiry to `quoting` makes module 02 raise a **real** draft
 * quotation from the live counter, and nothing in the test was tracking it. That leak is fixed at
 * source; this clears what it already left.
 *
 * Deliberately narrow. It matches only the shapes the test fixtures produce — a title beginning
 * "PO test ", a supplier whose code the fixtures generate — and it refuses to touch anything a
 * person could have created. A purge script that guesses is worse than leftovers.
 *
 * Pass `--apply`. Without it this only reports.
 */

async function main() {
  const apply = process.argv.includes("--apply");

  // The fixture titles, verbatim from the test files.
  const quotations = await db.quotation.findMany({
    where: {
      OR: [
        { title: { startsWith: "PO test " } },
        { title: { startsWith: "Supply and commission " } },
        { title: { startsWith: "Supply " } },
      ],
      // Never a quotation that reached anybody. The fixtures never send.
      sentAt: null,
      customerPOs: { none: {} },
    },
    select: { id: true, number: true, title: true, status: true },
    orderBy: { number: "asc" },
  });

  /**
   * Fixture suppliers, matched two ways.
   *
   * The straightforward ones carry a code the tests generate. The awkward ones carry a **real**
   * `AIESSUP-` code, because the dev server's job drainer was running during a test run and
   * processed the `principal.appointed` events those tests emitted — converting test prospects into
   * genuine supplier records that outlived the prospects their fixtures deleted.
   *
   * Those are matched on the fixtures' signature instead: every one appends a six-character hex
   * suffix to its name (`Test Instruments a5e28f`). Deliberately **not** matched on "is a principal
   * with no linked prospect", which would also catch a supplier somebody typed in by hand and
   * ticked as a principal — `Bestop` is exactly that, and deleting it would be destroying real work
   * to tidy up after a test.
   */
  const FIXTURE_CODE = /^(SPO|GRN|PDF|SUPT)-/;
  /** Every supplier fixture in the suite appends `randomUUID().slice(0, 6)` to its name. */
  const FIXTURE_NAME = /\s[0-9a-f]{6}$/;

  const suppliers = (
    await db.supplier.findMany({
      where: { supplierPOs: { none: {} }, supplierQuoteRequests: { none: {} } },
      select: { id: true, code: true, name: true },
    })
  ).filter((s) => FIXTURE_CODE.test(s.code) || FIXTURE_NAME.test(s.name));

  const accounts = await db.customerAccount.findMany({
    where: {
      OR: [
        { code: { startsWith: "PO-" } },
        { code: { startsWith: "SO-" } },
        { code: { startsWith: "SPO-" } },
        { code: { startsWith: "GRN-" } },
        { code: { startsWith: "AR-" } },
      ],
      quotations: { none: {} },
      inquiries: { none: {} },
    },
    select: { id: true, code: true, name: true },
  });

  console.log(`QUOTATIONS (${quotations.length})`);
  for (const q of quotations)
    console.log(`  ${q.number.padEnd(16)} ${q.status.padEnd(10)} ${q.title}`);
  console.log(`\nSUPPLIERS (${suppliers.length})`);
  for (const s of suppliers) console.log(`  ${s.code.padEnd(18)} ${s.name}`);
  console.log(`\nACCOUNTS (${accounts.length})`);
  for (const a of accounts) console.log(`  ${a.code.padEnd(18)} ${a.name}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to delete.");
    return;
  }

  const quotationIds = quotations.map((q) => q.id);
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });

  await db.supplier.deleteMany({ where: { id: { in: suppliers.map((s) => s.id) } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });

  console.log(
    `\nDeleted ${quotations.length} quotation(s), ${suppliers.length} supplier(s), ` +
      `${accounts.length} account(s). Reset the counters next.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
