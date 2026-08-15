import { db } from "../src/lib/db";

/**
 * Removes named quotations from the database entirely — rows gone, not flagged.
 *
 * **This is not the delete button and must never become it.** `deleteQuotationService` is the
 * ordinary path: soft, audited, and it keeps the number occupied because Spec.md §5 says a number
 * is never reused. That rule protects documents that went *outside the building*.
 *
 * This script is for the opposite case, and only that one: records the company created to try the
 * app out, which never reached a customer and which nobody will ever need to look up. Leaving them
 * soft-deleted means their numbers sit in the unique index forever, so a restarted series would
 * eventually collide with a quotation that never existed in any real sense.
 *
 * It refuses to run against anything with a customer PO behind it, because that is a real order,
 * and it prints everything it is about to destroy. Pass `--apply` to write.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const numbers = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (numbers.length === 0) {
    console.error("Give at least one quotation number.");
    process.exitCode = 1;
    return;
  }

  const targets = await db.quotation.findMany({
    where: { number: { in: numbers } },
    select: {
      id: true,
      number: true,
      revision: true,
      status: true,
      title: true,
      sentAt: true,
      deletedAt: true,
      _count: { select: { lines: true, rfqs: true, customerPOs: true, negotiationRounds: true } },
    },
    orderBy: [{ number: "asc" }, { revision: "asc" }],
  });

  if (targets.length === 0) {
    console.log("Nothing matches those numbers.");
    return;
  }

  for (const q of targets) {
    console.log(
      `${q.number} rev${q.revision} — ${q.status} — ${q.deletedAt ? "soft-deleted" : "LIVE"} — ` +
        `${q._count.lines} line(s), ${q._count.rfqs} RFQ(s), ${q._count.customerPOs} PO(s), ` +
        `${q._count.negotiationRounds} negotiation round(s) — ${q.title}`,
    );
  }

  const withOrders = targets.filter((q) => q._count.customerPOs > 0);
  if (withOrders.length > 0) {
    console.error(
      `\nRefusing: ${withOrders.map((q) => q.number).join(", ")} has a customer PO against it. ` +
        `That is a real order, and destroying the quotation would leave it pointing at nothing.`,
    );
    process.exitCode = 1;
    return;
  }

  const ids = targets.map((q) => q.id);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to destroy these rows permanently.");
    return;
  }

  // Order matters: everything that references a quotation goes before the quotation itself, and
  // revisions before their parent (parentQuotationId is a real foreign key).
  await db.$transaction(async (tx) => {
    const rfqs = await tx.supplierQuoteRequest.findMany({
      where: { quotationId: { in: ids } },
      select: { id: true },
    });
    const rfqIds = rfqs.map((r) => r.id);
    if (rfqIds.length > 0) {
      await tx.supplierQuoteLine.deleteMany({ where: { requestId: { in: rfqIds } } });
      await tx.supplierQuoteRequest.deleteMany({ where: { id: { in: rfqIds } } });
    }

    await tx.negotiationRound.deleteMany({ where: { quotationId: { in: ids } } });
    await tx.quotationLine.deleteMany({ where: { quotationId: { in: ids } } });

    // §6's approval requests, and the actions taken on them.
    const approvals = await tx.approvalRequest.findMany({
      where: { entityId: { in: ids } },
      select: { id: true },
    });
    if (approvals.length > 0) {
      const approvalIds = approvals.map((a) => a.id);
      await tx.approvalAction.deleteMany({ where: { requestId: { in: approvalIds } } });
      await tx.approvalRequest.deleteMany({ where: { id: { in: approvalIds } } });
    }

    // Polymorphic tables, matched by entity id rather than by a foreign key.
    await tx.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...rfqIds] } } });
    await tx.comment.deleteMany({ where: { entityId: { in: ids } } });
    await tx.searchIndex.deleteMany({ where: { entityId: { in: ids } } });
    await tx.notification.deleteMany({ where: { entityId: { in: [...ids, ...rfqIds] } } });
    await tx.fileObject.deleteMany({ where: { entityId: { in: [...ids, ...rfqIds] } } });

    // Revisions first — a parent cannot go while a child still points at it.
    const byRevisionDesc = [...targets].sort((a, b) => b.revision - a.revision);
    for (const q of byRevisionDesc) {
      await tx.quotation.delete({ where: { id: q.id } });
      console.log(`destroyed ${q.number} rev${q.revision}`);
    }
  });

  console.log(
    `\nGone. Those numbers are free again — re-run scripts/reset-numbering-counters.ts if the ` +
      `counter was being held above them.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
