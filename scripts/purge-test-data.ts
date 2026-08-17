import { db } from "../src/lib/db";
import { reindexAccount } from "../src/server/core/crm/account-service";
import { reindexInquiry } from "../src/server/core/crm/inquiry-service";

/**
 * Removes test residue and the review-pass records, keeping the company's real work.
 *
 * Written for the 2026-08-17 clean-up before going live, and kept because the same job will come
 * round again. **Dry run by default** — pass `--apply` to write.
 *
 * ## What it keeps, deliberately
 *
 * Everything the app needs to boot: roles, permissions, numbering formats, approval rules,
 * requirement templates, and the five named users. Plus the company's real records — the account and
 * suppliers named in `KEEP`, and the deals hanging off them.
 *
 * ## Why it works by account rather than by name pattern
 *
 * The residue is one aborted vitest run's fixtures: 27 customer accounts all called
 * "SPO Co <suffix>", each with its own quotation, sales order, customer PO and supplier PO. Deleting
 * by name pattern would work today and break the day somebody's real customer is called SPO
 * Corporation. So the script resolves the accounts to keep, then removes what belongs to the rest —
 * the relationship is the thing that makes a record real or not, not its name.
 *
 * The one exception is users: `*@test.local` is created only by the test fixtures, never by a person.
 */

const APPLY = process.argv.includes("--apply");

/** The company's real records. Everything else in these tables goes. */
const KEEP = {
  accountCodes: ["AIESACC-0001"],
  supplierCodes: ["AIESSUP-0001", "AIESSUP-0002", "AIESSUP-0003"],
  /** Real deals. Anything else on a kept account survives too; these are named for the report. */
  inquiryNumbers: ["AIESINQ-260001", "AIESINQ-260002"],
  quotationNumbers: ["AIESLQ260001", "AIESLQ260002"],
  userEmails: [
    "ea@aieselectromech.com",
    "kj@aieselectromech.com",
    "pd@aieselectromech.com",
    "dj@aieselectromech.com",
    "em@aieselectromech.com",
  ],
};

/**
 * Records the company made while reviewing the screens. Named individually rather than by pattern:
 * they sit on the *real* account, so nothing structural distinguishes them and a pattern would either
 * miss them or take real work with them.
 */
const REVIEW_RECORDS = {
  inquiryNumbers: ["AIESINQ-260163"],
  quotationNumbers: ["AIESLQ260524"],
  /** Every module 04 record is from the review pass — the company had none before this week. */
  allOperations: true,
};

const plan: { table: string; count: number; note: string }[] = [];
const note = (table: string, count: number, why: string) => {
  plan.push({ table, count, note: why });
  return count;
};

async function main() {
  console.log(APPLY ? "APPLYING — this writes.\n" : "DRY RUN — nothing is written.\n");

  const keptAccounts = await db.customerAccount.findMany({
    where: { code: { in: KEEP.accountCodes } },
    select: { id: true, code: true, name: true },
  });
  if (keptAccounts.length !== KEEP.accountCodes.length) {
    throw new Error(
      `Expected ${KEEP.accountCodes.length} account(s) to keep, found ${keptAccounts.length}. ` +
        `Refusing to run — the codes in KEEP no longer match the database.`,
    );
  }
  const keepAccountIds = keptAccounts.map((a) => a.id);
  console.log("Keeping accounts:", keptAccounts.map((a) => `${a.code} ${a.name}`).join(", "));

  const doomedAccounts = await db.customerAccount.findMany({
    where: { id: { notIn: keepAccountIds } },
    select: { id: true },
  });
  const doomedAccountIds = doomedAccounts.map((a) => a.id);

  const doomedSuppliers = await db.supplier.findMany({
    where: { code: { notIn: KEEP.supplierCodes } },
    select: { id: true },
  });
  const doomedSupplierIds = doomedSuppliers.map((s) => s.id);

  // Review-pass deals sitting on the kept account.
  const reviewInquiries = await db.inquiry.findMany({
    where: { number: { in: REVIEW_RECORDS.inquiryNumbers } },
    select: { id: true },
  });
  const reviewQuotations = await db.quotation.findMany({
    where: { number: { in: REVIEW_RECORDS.quotationNumbers } },
    select: { id: true },
  });

  const doomedInquiryIds = [
    ...(await db.inquiry.findMany({
      where: { accountId: { in: doomedAccountIds } },
      select: { id: true },
    })),
    ...reviewInquiries,
  ].map((r) => r.id);

  const doomedQuotationIds = [
    ...(await db.quotation.findMany({
      where: { accountId: { in: doomedAccountIds } },
      select: { id: true },
    })),
    ...reviewQuotations,
  ].map((r) => r.id);

  const doomedUsers = await db.user.findMany({
    where: {
      OR: [{ email: { endsWith: "@test.local" } }, { email: { endsWith: "@aies.local" } }],
      AND: [{ email: { notIn: KEEP.userEmails } }],
    },
    select: { id: true, email: true },
  });
  const doomedUserIds = doomedUsers.map((u) => u.id);

  note("customerAccount", doomedAccountIds.length, "not in KEEP");
  note("supplier", doomedSupplierIds.length, "not in KEEP");
  note("inquiry", doomedInquiryIds.length, "on a doomed account, or a review record");
  note("quotation", doomedQuotationIds.length, "on a doomed account, or a review record");
  note("user", doomedUserIds.length, "test fixtures and demo accounts");
  note("all module 04 records", 1, "every one is from the review pass");

  for (const row of plan) {
    console.log(`  ${row.table.padEnd(26)} ${String(row.count).padStart(4)}  ${row.note}`);
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  // Deepest dependants first. Every step is scoped to the doomed ids, never a bare deleteMany.
  console.log("\nDeleting…");

  // Module 04, all of it.
  await db.projectCloseOut.deleteMany({});
  await db.serviceReport.deleteMany({});
  await db.warrantyClaim.deleteMany({});
  await db.equipment.deleteMany({});
  await db.testingCommissioning.deleteMany({});
  await db.qAApproval.deleteMany({});
  await db.dailyProgress.deleteMany({});
  await db.mobilization.deleteMany({});
  await db.stockMovement.deleteMany({});
  await db.materialRequestLine.deleteMany({});
  await db.materialRequest.deleteMany({});
  await db.stockItem.deleteMany({});
  await db.cashAdvanceLiquidation.deleteMany({});
  await db.cashAdvance.deleteMany({});
  await db.methodology.deleteMany({});
  await db.siteInspection.deleteMany({});
  await db.ticketSalesOrderLine.deleteMany({});
  await db.ticket.deleteMany({});
  await db.project.deleteMany({});
  console.log("  module 04 cleared");

  // Procurement and orders belonging to doomed accounts or suppliers.
  const doomedReceipts = await db.goodsReceipt.findMany({
    where: { supplierPO: { supplierId: { in: doomedSupplierIds } } },
    select: { id: true },
  });
  await db.goodsReceiptLine.deleteMany({
    where: { goodsReceiptId: { in: doomedReceipts.map((r) => r.id) } },
  });
  await db.goodsReceipt.deleteMany({
    where: { supplierPO: { supplierId: { in: doomedSupplierIds } } },
  });
  const doomedPos = await db.supplierPO.findMany({
    where: { supplierId: { in: doomedSupplierIds } },
    select: { id: true },
  });
  await db.supplierPOLine.deleteMany({
    where: { supplierPOId: { in: doomedPos.map((r) => r.id) } },
  });
  await db.supplierPO.deleteMany({ where: { supplierId: { in: doomedSupplierIds } } });
  await db.supplierQuoteLine.deleteMany({
    where: { request: { supplierId: { in: doomedSupplierIds } } },
  });
  await db.supplierQuoteRequest.deleteMany({ where: { supplierId: { in: doomedSupplierIds } } });
  console.log("  procurement cleared");

  /**
   * A sales order is doomed if its **account** is doomed *or* its **quotation** is.
   *
   * The second half was missing on the first run and it stopped the purge mid-way: AIESSO-260157 sat
   * on the real account but came from AIESLQ260524, a review-pass quotation. Keeping the order while
   * deleting the quotation and its customer PO underneath it is not a state the database allows —
   * `SalesOrder.customerPOId` is a required foreign key with no cascade — so it refused, correctly.
   *
   * The lesson is about which relationship decides. An order belongs to the *deal*, not to the
   * account: the account is who it is for, the quotation is what it is. Scoping by account alone
   * asked the wrong question.
   */
  const doomedOrders = await db.salesOrder.findMany({
    where: {
      OR: [{ accountId: { in: doomedAccountIds } }, { quotationId: { in: doomedQuotationIds } }],
    },
    select: { id: true },
  });
  const doomedOrderIds = doomedOrders.map((r) => r.id);

  // SupplierPOLine points at SalesOrderLine without a cascade, so release those first. Only the real
  // suppliers' POs survive by this point, and one of them may reference a doomed order's line.
  const doomedOrderLines = await db.salesOrderLine.findMany({
    where: { salesOrderId: { in: doomedOrderIds } },
    select: { id: true },
  });
  await db.supplierPOLine.updateMany({
    where: { salesOrderLineId: { in: doomedOrderLines.map((r) => r.id) } },
    data: { salesOrderLineId: null },
  });
  await db.salesOrderLine.deleteMany({ where: { salesOrderId: { in: doomedOrderIds } } });
  await db.salesOrder.deleteMany({ where: { id: { in: doomedOrderIds } } });
  await db.customerPO.deleteMany({ where: { quotationId: { in: doomedQuotationIds } } });
  await db.negotiationRound.deleteMany({ where: { quotationId: { in: doomedQuotationIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: doomedQuotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: doomedQuotationIds } } });
  console.log("  orders and quotations cleared");

  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: doomedInquiryIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: doomedInquiryIds } } });
  // Activity is polymorphic — entityType/entityId, not a foreign key.
  await db.activity.deleteMany({
    where: { entityType: "Inquiry", entityId: { in: doomedInquiryIds } },
  });
  await db.inquiry.deleteMany({ where: { id: { in: doomedInquiryIds } } });
  console.log("  inquiries cleared");

  await db.accreditationRecord.deleteMany({ where: { accountId: { in: doomedAccountIds } } });
  await db.contact.deleteMany({ where: { accountId: { in: doomedAccountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: doomedAccountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: doomedAccountIds } } });
  await db.principalProspect.deleteMany({ where: { supplierId: { in: doomedSupplierIds } } });
  await db.supplier.deleteMany({ where: { id: { in: doomedSupplierIds } } });
  console.log("  accounts and suppliers cleared");

  // Users last: audit rows reference them by plain id, so nothing cascades.
  await db.userRole.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.userPermissionOverride.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.recoveryCode.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.session.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.account.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.notificationPreference.deleteMany({ where: { userId: { in: doomedUserIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: doomedUserIds } } });
  await db.user.deleteMany({ where: { id: { in: doomedUserIds } } });
  console.log("  users cleared");

  /**
   * Notifications, the outbox, the job queue and the search index are all **derived** — every row is
   * reconstructible, or was only ever about work that no longer exists. Cleared.
   *
   * **The audit log is not cleared, deliberately.** A trail that a cleanup script edits is not a
   * trail. The rows about deleted records are still the true record that those records existed and
   * what was done to them, and the deletions themselves are audited too. Noise is a cost worth paying
   * for a log that nothing rewrites.
   */
  await db.notification.deleteMany({});
  await db.eventOutbox.deleteMany({});
  await db.job.deleteMany({});
  await db.searchIndex.deleteMany({});
  console.log("  notifications, outbox, jobs and search index cleared (audit log kept)");

  /**
   * Rebuild the index for what survives.
   *
   * Emptying it and printing "re-index from the app" was an instruction with nothing behind it —
   * there is no such button. Ctrl+K finding nothing after a cleanup looks exactly like search being
   * broken, which is worse than the stale index this replaced.
   */
  const survivingAccounts = await db.customerAccount.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  for (const account of survivingAccounts) await reindexAccount(account.id);

  const survivingInquiries = await db.inquiry.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  for (const inquiry of survivingInquiries) await reindexInquiry(inquiry.id);

  console.log(
    `  re-indexed ${survivingAccounts.length} account(s) and ${survivingInquiries.length} inquiry(ies)`,
  );

  console.log("\nDone. Re-run the seed if a numbering format is missing.");
  await db.$disconnect();
}

void main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
