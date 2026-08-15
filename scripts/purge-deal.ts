import { db } from "../src/lib/db";

/**
 * Destroys a whole deal — inquiry, its quotations and every revision, the customer PO, the supplier
 * RFQs, the files — by inquiry number.
 *
 * ## Why this exists alongside purge-quotations.ts
 *
 * That script removes quotations and deliberately **refuses** when a customer PO points at one,
 * because destroying a quotation out from under a real order is exactly the accident worth
 * preventing. This one is for the case where the *whole thing* was a test: the inquiry, the
 * quotation raised from it, the PO recorded against it. Nothing here reached a customer, so there is
 * nothing to protect — and leaving half of it behind is worse than removing all of it.
 *
 * **Not the delete button, and never to be pointed at real work.** Spec.md §5's "numbers are never
 * reused" governs documents that went outside the building; `deleteQuotationService` is the ordinary
 * path and it is soft. This is for clearing the company's own trial records so a series can restart,
 * and it prints everything it is about to destroy before it does.
 *
 * Arguments are inquiry numbers. Pass `--apply` to write.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const numbers = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (numbers.length === 0) {
    console.error("Give at least one inquiry number, e.g. INQ-2608-0003.");
    process.exitCode = 1;
    return;
  }

  const inquiries = await db.inquiry.findMany({
    where: { number: { in: numbers } },
    select: {
      id: true,
      number: true,
      subject: true,
      status: true,
      quotations: { select: { id: true, number: true, revision: true, status: true } },
      customerPOs: { select: { id: true, poNumber: true } },
      inspections: { select: { id: true } },
      _count: { select: { items: true } },
    },
  });

  if (inquiries.length === 0) {
    console.log("Nothing matches those inquiry numbers.");
    return;
  }

  const missing = numbers.filter((n) => !inquiries.some((i) => i.number === n));
  if (missing.length > 0) {
    console.error(`Refusing: no inquiry named ${missing.join(", ")}. Check the numbers.`);
    process.exitCode = 1;
    return;
  }

  const inquiryIds = inquiries.map((i) => i.id);
  const quotationIds = inquiries.flatMap((i) => i.quotations.map((q) => q.id));

  // RFQs can hang off the quotation or the inquiry, so both routes are collected.
  const rfqs = await db.supplierQuoteRequest.findMany({
    where: {
      OR: [{ quotationId: { in: quotationIds } }, { inquiryId: { in: inquiryIds } }],
    },
    select: { id: true, number: true },
  });
  const rfqIds = rfqs.map((r) => r.id);

  for (const inquiry of inquiries) {
    console.log(`\n${inquiry.number} — ${inquiry.subject} (${inquiry.status})`);
    console.log(`  ${inquiry._count.items} item(s), ${inquiry.inspections.length} inspection(s)`);
    for (const q of inquiry.quotations) {
      console.log(`  quotation ${q.number} rev${q.revision} (${q.status})`);
    }
    for (const po of inquiry.customerPOs) console.log(`  customer PO ${po.poNumber}`);
  }
  if (rfqs.length > 0) console.log(`\nsupplier RFQs: ${rfqs.map((r) => r.number).join(", ")}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to destroy these rows permanently.");
    return;
  }

  const allEntityIds = [...inquiryIds, ...quotationIds, ...rfqIds];

  await db.$transaction(async (tx) => {
    // Children before parents throughout. The one ordering that is easy to get wrong is the
    // quotation revision chain: `parentQuotationId` is a real foreign key, so a parent cannot go
    // while a revision still points at it.
    if (rfqIds.length > 0) {
      await tx.supplierQuoteLine.deleteMany({ where: { requestId: { in: rfqIds } } });
      await tx.supplierQuoteRequest.deleteMany({ where: { id: { in: rfqIds } } });
    }

    await tx.customerPO.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
    await tx.customerPO.deleteMany({ where: { quotationId: { in: quotationIds } } });

    await tx.negotiationRound.deleteMany({ where: { quotationId: { in: quotationIds } } });
    await tx.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });

    const approvals = await tx.approvalRequest.findMany({
      where: { entityId: { in: quotationIds } },
      select: { id: true },
    });
    if (approvals.length > 0) {
      const approvalIds = approvals.map((a) => a.id);
      await tx.approvalAction.deleteMany({ where: { requestId: { in: approvalIds } } });
      await tx.approvalRequest.deleteMany({ where: { id: { in: approvalIds } } });
    }

    // Polymorphic tables, matched by entity id rather than by a foreign key.
    await tx.auditLog.deleteMany({ where: { entityId: { in: allEntityIds } } });
    await tx.comment.deleteMany({ where: { entityId: { in: allEntityIds } } });
    await tx.searchIndex.deleteMany({ where: { entityId: { in: allEntityIds } } });
    await tx.notification.deleteMany({ where: { entityId: { in: allEntityIds } } });
    await tx.activity.deleteMany({ where: { entityId: { in: allEntityIds } } });

    const inspectionIds = inquiries.flatMap((i) => i.inspections.map((s) => s.id));
    if (inspectionIds.length > 0) {
      await tx.auditLog.deleteMany({ where: { entityId: { in: inspectionIds } } });
      await tx.fileObject.deleteMany({ where: { entityId: { in: inspectionIds } } });
      await tx.inspectionRequest.deleteMany({ where: { id: { in: inspectionIds } } });
    }
    await tx.fileObject.deleteMany({ where: { entityId: { in: allEntityIds } } });

    // Revisions first, highest first, so no parent is removed while a child points at it.
    const ordered = inquiries.flatMap((i) => i.quotations).sort((a, b) => b.revision - a.revision);
    for (const q of ordered) {
      await tx.quotation.delete({ where: { id: q.id } });
      console.log(`destroyed quotation ${q.number} rev${q.revision}`);
    }

    await tx.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
    await tx.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
    for (const inquiry of inquiries) console.log(`destroyed inquiry ${inquiry.number}`);
  });

  console.log(
    `\nGone. Run scripts/reset-numbering-counters.ts --apply to bring the counters back down.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
