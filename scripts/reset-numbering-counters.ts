import { db } from "../src/lib/db";

/**
 * Restarts the document counters after clearing sample data.
 *
 * Spec.md §5 says numbers are "never reused, never reordered", which is a rule about a **live**
 * system: a number that reached a customer must never appear again. Numbers burned on demo records
 * that have just been deleted never reached anybody, and leaving the next real quotation at
 * AIESLQ260442 would make the company's first document look like their four-hundredth.
 *
 * **A counter is never lowered past a number that still exists.** Restarting the account series to
 * zero while `ACC-0001` is still on the books would hand the next account a code the database
 * refuses. So each counter is set to the highest number actually in use, which is zero once the
 * series is empty and exactly right when it is not.
 *
 * Pass `--apply`. Without it this only reports.
 */

/** The counter a series must not go below, given the rows still present. */
async function highestInUse(documentType: string): Promise<number> {
  const tail = (value: string) => Number(value.slice(-4));

  switch (documentType) {
    case "account": {
      const rows = await db.customerAccount.findMany({ select: { code: true } });
      return rows.reduce((max, r) => Math.max(max, tail(r.code) || 0), 0);
    }
    case "inquiry": {
      const rows = await db.inquiry.findMany({ select: { number: true } });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    case "quotation_local":
    case "quotation_indent": {
      const prefix = documentType === "quotation_local" ? "AIESLQ" : "AIESIQ";
      const rows = await db.quotation.findMany({
        where: { number: { startsWith: prefix } },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    default:
      return 0;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sequences = await db.documentSequence.findMany({ orderBy: { documentType: "asc" } });

  const plan: { id: string; documentType: string; scopeKey: string; from: number; to: number }[] =
    [];
  for (const seq of sequences) {
    const floor = await highestInUse(seq.documentType);
    plan.push({
      id: seq.id,
      documentType: seq.documentType,
      scopeKey: seq.scopeKey,
      from: seq.counter,
      to: floor,
    });
  }

  for (const row of plan) {
    const note = row.to > 0 ? `  (held at ${row.to} — that number is still in use)` : "";
    console.log(
      `${row.documentType.padEnd(20)} ${row.scopeKey.padEnd(8)} ${row.from} → ${row.to}${note}`,
    );
  }

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  for (const row of plan) {
    await db.documentSequence.update({ where: { id: row.id }, data: { counter: row.to } });
  }
  console.log("\nCounters reset.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
