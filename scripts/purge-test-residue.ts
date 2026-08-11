import { db } from "../src/lib/db";

/**
 * Deletes business rows whose owner is not a real user.
 *
 * Integration tests act as fabricated actors (`po-3f9a…`, `terms-8b21…`) rather than seeded users,
 * and clean up after themselves in `afterAll`. When a run is interrupted — or when a dev server is
 * left running and its job drainer creates *more* rows from the tests' events after the cleanup has
 * passed — the residue outlives the run and shows up in the app as nonsense accounts.
 *
 * The rule is deliberately structural rather than a name pattern: an owner id that matches no `User`
 * row cannot have been created by anybody using this system. Real data is never selected by it.
 *
 * Pass `--apply` to delete. Without it this only reports, which is the right default for anything
 * that removes rows.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const userIds = new Set((await db.user.findMany({ select: { id: true } })).map((u) => u.id));
  const orphan = (id: string | null | undefined) => !!id && !userIds.has(id);

  const accounts = (
    await db.customerAccount.findMany({
      select: { id: true, code: true, name: true, ownerId: true },
    })
  ).filter((a) => orphan(a.ownerId));
  const inquiries = (
    await db.inquiry.findMany({ select: { id: true, number: true, ownerId: true } })
  ).filter((i) => orphan(i.ownerId));
  const quotations = (
    await db.quotation.findMany({ select: { id: true, number: true, preparedById: true } })
  ).filter((q) => orphan(q.preparedById));

  const accountIds = accounts.map((a) => a.id);
  // Anything hanging off a doomed account has to go with it, or the delete fails on a foreign key.
  const dependentInquiries = await db.inquiry.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true, number: true },
  });
  const dependentQuotations = await db.quotation.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true, number: true },
  });

  const inquiryIds = [
    ...new Set([...inquiries.map((i) => i.id), ...dependentInquiries.map((i) => i.id)]),
  ];
  const quotationIds = [
    ...new Set([...quotations.map((q) => q.id), ...dependentQuotations.map((q) => q.id)]),
  ];

  console.log(`Accounts with no real owner: ${accounts.length}`);
  for (const a of accounts) console.log(`  ${a.code} — ${a.name}`);
  console.log(`Inquiries to remove: ${inquiryIds.length}`);
  console.log(`Quotations to remove: ${quotationIds.length}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to delete.");
    return;
  }

  await db.customerPO.deleteMany({
    where: {
      OR: [
        { inquiryId: { in: inquiryIds } },
        { quotationId: { in: quotationIds } },
        { accountId: { in: accountIds } },
      ],
    },
  });
  await db.approvalAction.deleteMany({
    where: { request: { entityId: { in: [...quotationIds, ...inquiryIds] } } },
  });
  await db.approvalRequest.deleteMany({
    where: { entityId: { in: [...quotationIds, ...inquiryIds] } },
  });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.accreditationRecord.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.contact.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });

  const entityIds = [...accountIds, ...inquiryIds, ...quotationIds];
  await db.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: entityIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: entityIds } } });

  console.log("\nDeleted.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
