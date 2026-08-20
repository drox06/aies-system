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

  /*
    Payment terms the fixtures invented.

    Found on 2026-08-20 while seeding module 05's walkthrough: 92 of them, against 5 real ones.
    Every one was a selectable option on a live quotation's payment-terms list. `SO-TERM-` never
    cleaned up at all; `Test term ` cleans up on a clean exit and leaks whenever a run is
    interrupted — which the concurrent-vitest false failures did more than once.

    Matched on the fixture names and then filtered again on **nothing referencing them**, because a
    payment term is what tells finance when to bill: deleting one a real quotation points at would
    leave that quotation unable to say what it promised.
  */
  const candidateTerms = await db.paymentTerm.findMany({
    where: { OR: [{ name: { startsWith: "SO-TERM-" } }, { name: { startsWith: "Test term " } }] },
    select: { id: true, name: true },
  });
  const candidateTermIds = candidateTerms.map((term) => term.id);
  const [termQuotations, termOrders, termAccounts] = await Promise.all([
    db.quotation.findMany({
      where: { paymentTermsId: { in: candidateTermIds } },
      select: { paymentTermsId: true },
    }),
    db.salesOrder.findMany({
      where: { paymentTermsId: { in: candidateTermIds } },
      select: { paymentTermsId: true },
    }),
    db.customerAccount.findMany({
      where: { paymentTermsId: { in: candidateTermIds } },
      select: { paymentTermsId: true },
    }),
  ]);
  const referenced = new Set(
    [...termQuotations, ...termOrders, ...termAccounts]
      .map((row) => row.paymentTermsId)
      .filter((id): id is string => !!id),
  );
  const terms = candidateTerms.filter((term) => !referenced.has(term.id));

  /*
    Sales orders left behind by `sales-order.test.ts`.

    Found 2026-08-20 by the first full suite run since §4's downpayment gate was written. That whole
    describe block created orders through the real service and never tracked their ids, so `afterAll`
    deleted the customer POs out from under them and died on `SalesOrder_customerPOId_fkey` — which
    then aborted the rest of the cleanup, leaking the quotations and accounts too. Three runs, seven
    orders each.

    Matched on the fixture's actor id, which is `so-` followed by eight hex characters and is
    generated per run. **A real order always has a real user's cuid as its owner**, so this cannot
    reach one. The alternative — matching the `AIESSO-` number prefix — would match every real order
    in the company, which is why it is not used.

    The numbers those orders consumed are gone. §3 of module 00 does not reuse a number, and a gap in
    a document series is the correct outcome here: it is a true record that a number was issued.
  */
  const FIXTURE_ACTOR = /^so-[0-9a-f]{8}$/;
  const leakedOrders = (
    await db.salesOrder.findMany({
      select: { id: true, number: true, ownerId: true, quotationId: true, customerPOId: true },
    })
  ).filter((order) => FIXTURE_ACTOR.test(order.ownerId ?? ""));

  /*
    Users the fixtures create on `@test.local`.

    Fourteen of them were live on 2026-08-20 — fifteen of the twenty active users were test
    accounts, which made "how many operations managers are there" read as fifteen when the answer
    is one. Module 06 builds assignee lists off exactly that question.

    Every one of those fixtures *has* a correct cleanup, in the right order, deleting `UserRole`
    before `User`. They leaked anyway, for the reason docs/DECISIONS.md #132 records: cleanup is
    sequential, so one failure part-way up the chain abandons everything below it. That cannot be
    fixed by making each `afterAll` more careful, which is why it belongs in this sweep.

    Matched on the domain alone. No real account can hold `@test.local`, and the company's
    deliberate walkthrough helper sits on the real company domain — so the domain match protects it
    without a hand-maintained exclusion list that somebody would have to remember to update.
  */
  const testUsers = await db.user.findMany({
    where: { email: { endsWith: "@test.local" } },
    select: { id: true, name: true, email: true },
  });

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
      // Added 2026-08-20, after `--apply` died on `CustomerPO_accountId_fkey`. A fixture that
      // recorded a PO without a quotation left an account this filter called empty and the database
      // did not — and because the delete ran before the payment-term sweep, one unrelated leftover
      // aborted the whole run.
      customerPOs: { none: {} },
      salesOrders: { none: {} },
      tickets: { none: {} },
      projects: { none: {} },
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
  console.log(`\nLEAKED SALES ORDERS (${leakedOrders.length})`);
  for (const o of leakedOrders) console.log(`  ${o.number.padEnd(16)} owner ${o.ownerId}`);
  console.log(`\nPAYMENT TERMS (${terms.length} of ${candidateTerms.length} fixture-named)`);
  for (const t of terms) console.log(`  ${t.name}`);
  if (referenced.size > 0) {
    console.log(`  ${referenced.size} left alone — a live record points at them.`);
  }

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to delete.");
    return;
  }

  /*
    The leaked orders and the chain that authorised them, deepest first.

    Their accounts are resolved from the orders rather than from the generic account filter above,
    because that filter asks for accounts with no sales orders — which these have, right up until the
    line below runs. Resolving from the orders makes it one pass instead of two.
  */
  const leakedOrderIds = leakedOrders.map((order) => order.id);
  const leakedQuotationIds = leakedOrders
    .map((order) => order.quotationId)
    .filter((id): id is string => !!id);
  const leakedPoIds = leakedOrders
    .map((order) => order.customerPOId)
    .filter((id): id is string => !!id);
  const leakedAccountIds = [
    ...new Set(
      (
        await db.customerAccount.findMany({
          where: { salesOrders: { some: { id: { in: leakedOrderIds } } } },
          select: { id: true },
        })
      ).map((account) => account.id),
    ),
  ];
  const leakedFileIds = (
    await db.customerPO.findMany({
      where: { id: { in: leakedPoIds } },
      select: { fileId: true },
    })
  )
    .map((po) => po.fileId)
    .filter((id): id is string => !!id);

  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: leakedOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: leakedOrderIds } } });
  await db.customerPO.deleteMany({ where: { id: { in: leakedPoIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: leakedFileIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: leakedQuotationIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: leakedQuotationIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...leakedOrderIds, ...leakedQuotationIds, ...leakedAccountIds] } },
  });
  await db.quotation.deleteMany({ where: { id: { in: leakedQuotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: leakedAccountIds } } });

  const quotationIds = quotations.map((q) => q.id);
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });

  await db.supplier.deleteMany({ where: { id: { in: suppliers.map((s) => s.id) } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
  await db.paymentTerm.deleteMany({ where: { id: { in: terms.map((t) => t.id) } } });

  // Children first, as everywhere else here. Audit rows naming these users keep their id and
  // label — a record of who did something must not change because the account was tidied away.
  const testUserIds = testUsers.map((user) => user.id);
  await db.userRole.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.userPermissionOverride.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.account.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.recoveryCode.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.user.deleteMany({ where: { id: { in: testUserIds } } });

  console.log(
    `\nDeleted ${quotations.length} quotation(s), ${suppliers.length} supplier(s), ` +
      `${accounts.length} account(s), ${leakedOrders.length} leaked sales order(s), ` +
      `${terms.length} payment term(s), ${testUsers.length} test user(s). Reset the counters next.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
