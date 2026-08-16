import { db } from "../src/lib/db";
import { writeAuditLog } from "../src/server/core/audit/audit";
import { reindexInquiry } from "../src/server/core/crm/inquiry-service";

/**
 * The 2026-08-16 rename: every document series moves to the house template `AIES{CODE}-{YY}{####}`.
 *
 * ## Why this is not a normal operation
 *
 * Spec.md §5 is explicit that numbers are "never reused, never reordered", and that rule protects a
 * number that has been **outside the building** — on a customer's desk, in their accounts payable
 * system, quoted back on their purchase order. Renumbering one of those would be forgery.
 *
 * None of these have. `AIESRFQ-260001` is the only supplier-facing number in the database and it
 * was never sent; the sales order and supplier PO were raised while walking the build. So this is a
 * one-off cutover on a system with no issued documents, not a facility to keep.
 *
 * **Quotations are not touched.** `AIESLQ` and `AIESIQ` already follow the company's own convention,
 * are on documents that went to customers, and the company asked for them to be left alone.
 *
 * ## Two different jobs, deliberately kept apart
 *
 * - **Accounts and suppliers get a prefix and nothing else.** `ACC-0001` → `AIESACC-0001`. Their
 *   counters are yearless because they identify a relationship rather than a dated document, and
 *   their numbering already starts at 1 — renumbering them would change a customer's permanent code
 *   for no gain.
 * - **Transaction documents are renumbered from 1.** `AIESSO-260001` rather than `AIESSO-260189`:
 *   about 180 numbers in each series were burned by tests that then deleted their own records, and
 *   the company's first supplier PO should not go out numbered 00150.
 *
 * ## The audit trail
 *
 * Old audit rows quote the old number and are **not** rewritten — an audit log that edits itself is
 * worth nothing. Each renumber writes a *new* row saying what changed, so the discontinuity has an
 * explanation sitting next to it.
 *
 * Pass `--apply`. Without it this only reports.
 */

const ACTOR = { actorId: null, actorLabel: "System (house numbering format)" };
const YY = String(new Date().getFullYear()).slice(-2);

interface Change {
  entity: string;
  id: string;
  from: string;
  to: string;
}

const pad = (n: number, width = 4) => String(n).padStart(width, "0");

async function main() {
  const apply = process.argv.includes("--apply");
  const changes: Change[] = [];

  // ---- prefix only: the permanent identifiers ---------------------------------------------------

  const accounts = await db.customerAccount.findMany({
    where: { deletedAt: null, code: { startsWith: "ACC-" } },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });
  for (const account of accounts) {
    changes.push({
      entity: "CustomerAccount",
      id: account.id,
      from: account.code,
      // The digits are kept exactly: a customer's code is theirs permanently.
      to: `AIESACC-${account.code.slice("ACC-".length)}`,
    });
  }

  const suppliers = await db.supplier.findMany({
    where: { deletedAt: null, code: { startsWith: "SUP-" } },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });
  for (const supplier of suppliers) {
    changes.push({
      entity: "Supplier",
      id: supplier.id,
      from: supplier.code,
      to: `AIESSUP-${supplier.code.slice("SUP-".length)}`,
    });
  }

  // ---- renumbered from 1: the transaction documents ---------------------------------------------

  const inquiries = await db.inquiry.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true },
    orderBy: { createdAt: "asc" },
  });
  inquiries.forEach((inquiry, index) => {
    changes.push({
      entity: "Inquiry",
      id: inquiry.id,
      from: inquiry.number,
      to: `AIESINQ-${YY}${pad(index + 1)}`,
    });
  });

  const rfqs = await db.supplierQuoteRequest.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true },
    orderBy: { createdAt: "asc" },
  });
  rfqs.forEach((rfq, index) => {
    changes.push({
      entity: "SupplierQuoteRequest",
      id: rfq.id,
      from: rfq.number,
      to: `AIESRFQ-${YY}${pad(index + 1)}`,
    });
  });

  const salesOrders = await db.salesOrder.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true },
    orderBy: { createdAt: "asc" },
  });
  salesOrders.forEach((order, index) => {
    changes.push({
      entity: "SalesOrder",
      id: order.id,
      from: order.number,
      to: `AIESSO-${YY}${pad(index + 1)}`,
    });
  });

  const supplierPos = await db.supplierPO.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true },
    orderBy: { createdAt: "asc" },
  });
  supplierPos.forEach((po, index) => {
    changes.push({
      entity: "SupplierPO",
      id: po.id,
      from: po.number,
      to: `AIESPO-${YY}${pad(index + 1)}`,
    });
  });

  const receipts = await db.goodsReceipt.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true },
    orderBy: { createdAt: "asc" },
  });
  receipts.forEach((receipt, index) => {
    changes.push({
      entity: "GoodsReceipt",
      id: receipt.id,
      from: receipt.number,
      to: `AIESGRN-${YY}${pad(index + 1)}`,
    });
  });

  // ---- report -----------------------------------------------------------------------------------

  const untouched = await db.quotation.count({ where: { deletedAt: null } });
  for (const change of changes) {
    console.log(`  ${change.entity.padEnd(22)} ${change.from.padEnd(16)} → ${change.to}`);
  }
  console.log(`\n${changes.length} record(s) to renumber.`);
  console.log(`${untouched} quotation(s) deliberately left alone (AIESLQ / AIESIQ).`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  // ---- write ------------------------------------------------------------------------------------

  for (const change of changes) {
    switch (change.entity) {
      case "CustomerAccount":
        await db.customerAccount.update({ where: { id: change.id }, data: { code: change.to } });
        break;
      case "Supplier":
        await db.supplier.update({ where: { id: change.id }, data: { code: change.to } });
        break;
      case "Inquiry":
        await db.inquiry.update({ where: { id: change.id }, data: { number: change.to } });
        break;
      case "SupplierQuoteRequest":
        await db.supplierQuoteRequest.update({
          where: { id: change.id },
          data: { number: change.to },
        });
        break;
      case "SalesOrder":
        await db.salesOrder.update({ where: { id: change.id }, data: { number: change.to } });
        break;
      case "SupplierPO":
        await db.supplierPO.update({ where: { id: change.id }, data: { number: change.to } });
        break;
      case "GoodsReceipt":
        await db.goodsReceipt.update({ where: { id: change.id }, data: { number: change.to } });
        break;
    }

    await writeAuditLog(db, {
      actorId: ACTOR.actorId,
      actorLabel: ACTOR.actorLabel,
      action: "renumbered",
      entityType: change.entity,
      entityId: change.id,
      summary:
        `${change.from} is now ${change.to}. The company adopted one house numbering format on ` +
        `2026-08-16; earlier entries in this trail quote the old number.`,
      diff: { number: { from: change.from, to: change.to } },
    });
  }

  // The inquiry's number is part of its search document, so a renumbered inquiry that is not
  // reindexed stays findable only by its old number — which is the one that no longer exists.
  for (const change of changes.filter((c) => c.entity === "Inquiry")) {
    await reindexInquiry(change.id);
  }

  console.log("\nRenumbered. Run `npx tsx scripts/reset-numbering-counters.ts --apply` next.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
