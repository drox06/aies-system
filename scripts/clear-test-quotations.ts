import { db } from "../src/lib/db";
import { deleteQuotationService } from "../src/server/core/quotation/quotation-service";

/**
 * Clears named quotations so the local series can restart, using the ordinary delete path.
 *
 * Through `deleteQuotationService` rather than a raw `UPDATE`, deliberately: it is the same soft
 * delete a person gets from the record page, so it writes the same audit row, keeps the same
 * evidence, and refuses in the same places — a quotation with a customer PO against it will stop
 * this script exactly as it stops the button.
 *
 * Numbers to clear are arguments. Pass `--apply` to write.
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
    where: { deletedAt: null, number: { in: numbers } },
    select: { id: true, number: true, revision: true, status: true, title: true },
    orderBy: [{ number: "asc" }, { revision: "asc" }],
  });

  if (targets.length === 0) {
    console.log("Nothing live matches those numbers.");
    return;
  }

  for (const q of targets) {
    console.log(`${q.number} rev${q.revision} — ${q.status} — ${q.title}`);
  }

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to delete.");
    return;
  }

  for (const q of targets) {
    await deleteQuotationService(
      { actorId: "system-renumber", actorLabel: "System (series restart)" },
      {
        quotationId: q.id,
        reason: "Test quotation cleared so the local series could restart at 0002.",
      },
    );
    console.log(`deleted ${q.number} rev${q.revision}`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
