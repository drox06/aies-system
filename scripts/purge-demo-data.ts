import { db } from "../src/lib/db";

/**
 * Removes the sample records `npm run demo:crm` seeds, leaving real work untouched.
 *
 * Selection is by the `DEMO-` prefix the demo script stamps on everything it creates, plus whatever
 * hangs off those rows by foreign key. Nothing here matches a record a person typed.
 *
 * **One consequence to understand before running it.** A quotation belongs to an account, and that
 * relation is required. So a quotation raised against a demo account is demo data whatever its
 * number looks like — including one the job queue created on its own when a demo inquiry reached
 * `quoting`. It goes with the account; there is no keeping it.
 *
 * Pass `--apply` to delete. Without it this only reports.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  const accounts = await db.customerAccount.findMany({
    where: { code: { startsWith: "DEMO-" } },
    select: { id: true, code: true, name: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const inquiries = await db.inquiry.findMany({
    where: { OR: [{ number: { startsWith: "INQ-DEMO-" } }, { accountId: { in: accountIds } }] },
    select: { id: true, number: true },
  });
  const inquiryIds = inquiries.map((i) => i.id);

  const quotations = await db.quotation.findMany({
    where: { OR: [{ accountId: { in: accountIds } }, { inquiryId: { in: inquiryIds } }] },
    select: { id: true, number: true },
  });
  const quotationIds = quotations.map((q) => q.id);

  const principals = await db.principalProspect.findMany({
    where: { companyName: { startsWith: "DEMO-" } },
    select: { id: true, companyName: true },
  });
  const principalIds = principals.map((p) => p.id);

  console.log(`Demo accounts (${accounts.length}):`);
  for (const a of accounts) console.log(`  ${a.code} — ${a.name}`);
  console.log(
    `Inquiries (${inquiries.length}): ${inquiries.map((i) => i.number).join(", ") || "—"}`,
  );
  console.log(
    `Quotations that hang off them (${quotations.length}): ${quotations.map((q) => q.number).join(", ") || "—"}`,
  );
  console.log(
    `Principal prospects (${principals.length}): ${principals.map((p) => p.companyName).join(", ") || "—"}`,
  );

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to delete.");
    return;
  }

  // Children first, then parents — the foreign keys are RESTRICT, which is what makes an accidental
  // half-delete impossible rather than merely unlikely.
  await db.customerPO.deleteMany({
    where: {
      OR: [
        { accountId: { in: accountIds } },
        { inquiryId: { in: inquiryIds } },
        { quotationId: { in: quotationIds } },
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
  await db.activity.deleteMany({
    where: { entityId: { in: [...accountIds, ...inquiryIds, ...principalIds] } },
  });
  await db.contact.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.principalProspect.deleteMany({ where: { id: { in: principalIds } } });

  const entityIds = [...accountIds, ...inquiryIds, ...quotationIds, ...principalIds];
  await db.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: entityIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: entityIds } } });
  await db.comment.deleteMany({ where: { entityId: { in: entityIds } } });

  console.log("\nDeleted.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
