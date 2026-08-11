import { db } from "../src/lib/db";
import { writeAuditLog } from "../src/server/core/audit/audit";
import { reindexInquiry } from "../src/server/core/crm/inquiry-service";
import { indexEntity } from "../src/server/core/search/index-service";

/**
 * Renumbers the records left after clearing sample data, so each series can genuinely restart at
 * 0001.
 *
 * ## Why this is not a normal operation
 *
 * Spec.md §5 is explicit: numbers are "never reused, never reordered". That rule protects a number
 * that has been *outside the building* — on a customer's desk, in their accounts payable system, on
 * a purchase order that quotes it back. Renumbering one of those would be forgery.
 *
 * These have not. They are the records left from testing the build, and the company asked for a
 * clean start. So this is a one-off run against a system with no issued documents, not a facility.
 *
 * It **refuses** to touch a quotation with a `sentAt`, because that is the line between the two
 * cases and the one thing a script like this must not be trusted to remember by itself. Passing
 * `--include-sent` overrides the refusal, and is only defensible when the "customer" was a test
 * account — as it is here, where the send was recorded against the company's own trial data. If you
 * are reading this while deciding whether to pass that flag on a live system: don't.
 *
 * ## The audit trail
 *
 * Old audit rows quote the old number in their summary text, and they are not rewritten — an audit
 * log that edits itself is worth nothing. Instead each renumber writes a **new** row saying what
 * changed, so the discontinuity has an explanation sitting right next to it.
 *
 * Pass `--apply`. Without it this only reports.
 */

const ACTOR = { actorId: null, actorLabel: "System (series restart)" };

async function main() {
  const apply = process.argv.includes("--apply");

  const inquiries = await db.inquiry.findMany({
    where: { deletedAt: null },
    orderBy: { receivedAt: "asc" },
    select: { id: true, number: true },
  });
  const quotations = await db.quotation.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, number: true, revision: true, sentAt: true },
  });

  // The one hard refusal. A sent quotation's number is in somebody else's filing system.
  const includeSent = process.argv.includes("--include-sent");
  const issued = quotations.filter((q) => q.sentAt !== null);
  if (issued.length > 0 && includeSent) {
    console.log(
      `Overridden with --include-sent: ${issued.map((q) => q.number).join(", ")} ` +
        `${issued.length === 1 ? "was" : "were"} recorded as sent. Only valid because the recipient ` +
        `was a test account.
`,
    );
  }
  if (issued.length > 0 && !includeSent) {
    console.error(
      `Refusing: ${issued.map((q) => q.number).join(", ")} ${issued.length === 1 ? "has" : "have"} ` +
        `been sent to a customer. Spec.md §5 — a number that has left the building is never reused ` +
        `or reordered. Pass --include-sent only if the recipient was a test account.`,
    );
    process.exitCode = 1;
    return;
  }

  // Series are renumbered from 1 in the order the records were created, so the sequence still
  // reflects the order things happened.
  const inquiryPlan = inquiries.map((row, i) => ({
    ...row,
    to: `${row.number.slice(0, -4)}${String(i + 1).padStart(4, "0")}`,
  }));
  const quotationPlan = quotations.map((row, i) => ({
    ...row,
    to: `${row.number.slice(0, -4)}${String(i + 1).padStart(4, "0")}`,
  }));

  for (const row of inquiryPlan) console.log(`INQUIRY   ${row.number} → ${row.to}`);
  for (const row of quotationPlan) console.log(`QUOTATION ${row.number} → ${row.to}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  for (const row of inquiryPlan) {
    if (row.number === row.to) continue;
    await db.$transaction(async (tx) => {
      await tx.inquiry.update({ where: { id: row.id }, data: { number: row.to } });
      await writeAuditLog(tx, {
        ...ACTOR,
        action: "renumbered",
        entityType: "Inquiry",
        entityId: row.id,
        summary: `Renumbered ${row.number} to ${row.to} when the series was restarted after clearing sample data`,
        diff: { number: { from: row.number, to: row.to } },
      });
    });
    await reindexInquiry(row.id);
  }

  for (const row of quotationPlan) {
    if (row.number === row.to) continue;
    await db.$transaction(async (tx) => {
      await tx.quotation.update({ where: { id: row.id }, data: { number: row.to } });
      await writeAuditLog(tx, {
        ...ACTOR,
        action: "renumbered",
        entityType: "Quotation",
        entityId: row.id,
        summary: `Renumbered ${row.number} to ${row.to} when the series was restarted after clearing sample data`,
        diff: { number: { from: row.number, to: row.to } },
      });
    });
    const quotation = await db.quotation.findUnique({
      where: { id: row.id },
      select: { id: true, number: true, title: true, account: { select: { name: true } } },
    });
    if (quotation) {
      await indexEntity({
        entityType: "Quotation",
        entityId: quotation.id,
        title: `${quotation.number} — ${quotation.title}`,
        body: quotation.account.name,
        href: `/quotations/${quotation.id}`,
      });
    }
  }

  console.log("\nRenumbered. Run reset-numbering-counters.ts --apply to bring the counters down.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
