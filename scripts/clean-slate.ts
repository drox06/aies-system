import { db } from "../src/lib/db";

/**
 * Clears every transactional record and leaves the platform's configuration standing.
 *
 * ## What this is for
 *
 * The company asked on 2026-08-21 for a clean database before the end-to-end walkthrough: *"clear
 * all test samples or seed samples… this is all just test. nothing real."* Everything in the
 * database at that point was a fixture, a seed, or one of EA's own walkthroughs — 155 customer
 * accounts, of which 154 were named things like "Finance Co 1076884c".
 *
 * ## What survives, and why
 *
 * **Configuration, not data.** The six named users and their roles; the permission matrix; the
 * numbering formats; the payment terms; the checklist, task and requirement templates; the approval
 * workflows. None of that is a record of something that happened — it is the shape of the platform,
 * and re-seeding it would only put the same rows back.
 *
 * **The A4One account itself**, at the company's instruction, so there is a customer to quote
 * against on the first pass. Its *history* goes with everything else: it held `AIESINQ-260001`,
 * `AIESLQ260001` and `AIESSO-260001`, which are precisely the numbers a counter reset hands out
 * again — keeping them and resetting the counters would collide on the first document raised.
 *
 * **Suppliers and stock items** stay as master data, with their movements cleared and quantities
 * zeroed: a supplier is somebody the company buys from, not a thing that happened.
 *
 * ## How it fails
 *
 * Every step is guarded and reported. docs/DECISIONS.md #132: cleanup is sequential, so one failure
 * part-way up a chain abandons everything below it — which is how fourteen test users came to be
 * live in this database while every fixture that made them had a correct-looking teardown.
 *
 * Pass `--apply`. Without it this only counts.
 */

const KEEP_ACCOUNT_CODE = "AIESACC-0001";

interface Step {
  label: string;
  run: () => Promise<{ count: number }>;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const keep = await db.customerAccount.findFirst({
    where: { code: KEEP_ACCOUNT_CODE },
    select: { id: true, name: true },
  });

  console.log(
    keep
      ? `Keeping the account ${KEEP_ACCOUNT_CODE} (${keep.name}) and nothing that happened to it.`
      : `No ${KEEP_ACCOUNT_CODE} found — every account will go.`,
  );

  /*
    Deepest first.

    The order is the foreign keys read backwards: lines before their document, documents before the
    record they hang off, and everything before the account. Where a model has no relation to
    anything kept, it is simply emptied.
  */
  const steps: Step[] = [
    // ---- Collaboration -------------------------------------------------------------------------
    { label: "announcement acknowledgements", run: () => db.announcementAck.deleteMany({}) },
    { label: "announcements", run: () => db.announcement.deleteMany({}) },
    { label: "messages", run: () => db.message.deleteMany({}) },
    { label: "channel members", run: () => db.channelMember.deleteMany({}) },
    { label: "channels", run: () => db.channel.deleteMany({}) },
    { label: "meetings", run: () => db.meeting.deleteMany({}) },
    { label: "calendar events", run: () => db.calendarEvent.deleteMany({}) },
    { label: "tasks", run: () => db.task.deleteMany({}) },
    { label: "boards", run: () => db.board.deleteMany({}) },

    // ---- Finance -------------------------------------------------------------------------------
    { label: "payment allocations", run: () => db.paymentAllocation.deleteMany({}) },
    { label: "service invoices", run: () => db.serviceInvoice.deleteMany({}) },
    { label: "payments", run: () => db.payment.deleteMany({}) },
    { label: "collection activity", run: () => db.collectionActivity.deleteMany({}) },
    { label: "collection reminders", run: () => db.collectionReminder.deleteMany({}) },
    { label: "billing statement lines", run: () => db.billingStatementLine.deleteMany({}) },
    { label: "billing statements", run: () => db.billingStatement.deleteMany({}) },
    { label: "billing milestones", run: () => db.billingMilestone.deleteMany({}) },
    { label: "billing schedules", run: () => db.billingSchedule.deleteMany({}) },
    { label: "supplier invoices", run: () => db.supplierInvoice.deleteMany({}) },
    { label: "accounting exports", run: () => db.accountingExport.deleteMany({}) },
    { label: "expenses", run: () => db.expense.deleteMany({}) },
    { label: "cost rates", run: () => db.costRate.deleteMany({}) },

    // ---- Operations ----------------------------------------------------------------------------
    { label: "cash advance liquidations", run: () => db.cashAdvanceLiquidation.deleteMany({}) },
    { label: "cash advances", run: () => db.cashAdvance.deleteMany({}) },
    { label: "field expenses", run: () => db.fieldExpense.deleteMany({}) },
    { label: "timesheets", run: () => db.timesheet.deleteMany({}) },
    { label: "field submissions", run: () => db.fieldSubmission.deleteMany({}) },
    { label: "checklist responses", run: () => db.checklistResponse.deleteMany({}) },
    { label: "daily progress", run: () => db.dailyProgress.deleteMany({}) },
    { label: "QA approvals", run: () => db.qAApproval.deleteMany({}) },
    { label: "testing and commissioning", run: () => db.testingCommissioning.deleteMany({}) },
    { label: "service reports", run: () => db.serviceReport.deleteMany({}) },
    { label: "project close-outs", run: () => db.projectCloseOut.deleteMany({}) },
    { label: "warranty claims", run: () => db.warrantyClaim.deleteMany({}) },
    { label: "mobilizations", run: () => db.mobilization.deleteMany({}) },
    { label: "methodologies", run: () => db.methodology.deleteMany({}) },
    { label: "site inspections", run: () => db.siteInspection.deleteMany({}) },
    { label: "inspection requests", run: () => db.inspectionRequest.deleteMany({}) },
    { label: "material request lines", run: () => db.materialRequestLine.deleteMany({}) },
    { label: "material requests", run: () => db.materialRequest.deleteMany({}) },
    { label: "stock movements", run: () => db.stockMovement.deleteMany({}) },
    { label: "delivery receipt lines", run: () => db.deliveryReceiptLine.deleteMany({}) },
    { label: "delivery receipts", run: () => db.deliveryReceipt.deleteMany({}) },
    { label: "delivery ticket flows", run: () => db.deliveryTicketFlow.deleteMany({}) },
    { label: "maintenance contracts", run: () => db.maintenanceContract.deleteMany({}) },
    { label: "technician availability", run: () => db.technicianAvailability.deleteMany({}) },
    { label: "equipment", run: () => db.equipment.deleteMany({}) },
    { label: "ticket to sales-order lines", run: () => db.ticketSalesOrderLine.deleteMany({}) },
    { label: "tickets", run: () => db.ticket.deleteMany({}) },
    { label: "projects", run: () => db.project.deleteMany({}) },

    // ---- Procurement ---------------------------------------------------------------------------
    { label: "goods receipt lines", run: () => db.goodsReceiptLine.deleteMany({}) },
    { label: "goods receipts", run: () => db.goodsReceipt.deleteMany({}) },
    { label: "supplier PO lines", run: () => db.supplierPOLine.deleteMany({}) },
    { label: "supplier POs", run: () => db.supplierPO.deleteMany({}) },
    { label: "supplier quote lines", run: () => db.supplierQuoteLine.deleteMany({}) },
    { label: "supplier quote requests", run: () => db.supplierQuoteRequest.deleteMany({}) },
    { label: "negotiation rounds", run: () => db.negotiationRound.deleteMany({}) },

    // ---- Sales ---------------------------------------------------------------------------------
    { label: "sales order lines", run: () => db.salesOrderLine.deleteMany({}) },
    { label: "sales orders", run: () => db.salesOrder.deleteMany({}) },
    { label: "customer POs", run: () => db.customerPO.deleteMany({}) },
    { label: "quotation lines", run: () => db.quotationLine.deleteMany({}) },
    { label: "quotations", run: () => db.quotation.deleteMany({}) },
    { label: "inquiry items", run: () => db.inquiryItem.deleteMany({}) },
    { label: "inquiries", run: () => db.inquiry.deleteMany({}) },
    { label: "activities", run: () => db.activity.deleteMany({}) },
    { label: "accreditation records", run: () => db.accreditationRecord.deleteMany({}) },
    { label: "principal prospects", run: () => db.principalProspect.deleteMany({}) },

    // ---- Customers -----------------------------------------------------------------------------
    {
      label: "contacts (other accounts)",
      run: () =>
        db.contact.deleteMany(keep ? { where: { accountId: { not: keep.id } } } : undefined),
    },
    {
      label: "sites (other accounts)",
      run: () => db.site.deleteMany(keep ? { where: { accountId: { not: keep.id } } } : undefined),
    },
    {
      label: "customer accounts",
      run: () =>
        db.customerAccount.deleteMany(keep ? { where: { id: { not: keep.id } } } : undefined),
    },

    // ---- Platform traces -----------------------------------------------------------------------
    { label: "approval actions", run: () => db.approvalAction.deleteMany({}) },
    { label: "approval requests", run: () => db.approvalRequest.deleteMany({}) },
    { label: "comment edits", run: () => db.commentEdit.deleteMany({}) },
    { label: "comments", run: () => db.comment.deleteMany({}) },
    { label: "notifications", run: () => db.notification.deleteMany({}) },
    { label: "search index", run: () => db.searchIndex.deleteMany({}) },
    { label: "event outbox", run: () => db.eventOutbox.deleteMany({}) },
    { label: "jobs", run: () => db.job.deleteMany({}) },
    { label: "files", run: () => db.fileObject.deleteMany({}) },
    /*
      The audit log goes too, and only because every row in it describes something being deleted
      here. An audit trail is normally the last thing to touch — it is the evidence — but a trail
      pointing at records that no longer exist is not evidence of anything, and the company's first
      real month should not open with three thousand entries about fixtures.
    */
    { label: "audit log", run: () => db.auditLog.deleteMany({}) },
  ];

  if (!apply) {
    console.log("\nCounting only. Re-run with --apply.\n");
    const counts: [string, number][] = [
      ["customer accounts", await db.customerAccount.count()],
      ["inquiries", await db.inquiry.count()],
      ["quotations", await db.quotation.count()],
      ["sales orders", await db.salesOrder.count()],
      ["tickets", await db.ticket.count()],
      ["projects", await db.project.count()],
      ["methodologies", await db.methodology.count()],
      ["billing statements", await db.billingStatement.count()],
      ["service invoices", await db.serviceInvoice.count()],
      ["files", await db.fileObject.count()],
      ["audit rows", await db.auditLog.count()],
    ];
    for (const [label, n] of counts) console.log(`  ${label.padEnd(20)} ${n}`);
    return;
  }

  let removed = 0;
  const failures: string[] = [];

  for (const step of steps) {
    try {
      const { count } = await step.run();
      removed += count;
      if (count > 0) console.log(`  ${String(count).padStart(5)}  ${step.label}`);
    } catch (error) {
      // Reported and carried, never thrown: one failure must not abandon every step below it.
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${step.label}: ${reason}`);
      console.error(`  FAILED  ${step.label} — ${reason}`);
    }
  }

  // Stock items survive as master data; their quantities do not, because the movements behind them
  // have gone and a quantity nothing accounts for is worse than a zero.
  try {
    const { count } = await db.stockItem.updateMany({ data: { qtyOnHand: 0 } });
    if (count > 0) console.log(`  ${String(count).padStart(5)}  stock quantities zeroed`);
  } catch (error) {
    failures.push(`stock quantities: ${String(error)}`);
  }

  // The counters, last: reset only once the documents that consumed them are gone.
  const { count: sequences } = await db.documentSequence.deleteMany({});
  console.log(`  ${String(sequences).padStart(5)}  numbering counters reset to zero`);

  console.log(`\n${removed} row(s) removed.`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} step(s) failed:`);
    for (const failure of failures) console.log(`  ${failure}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
