import { db } from "../src/lib/db";
import { previewNumber } from "../src/server/core/numbering/numbering";

/** Read-only: what the next number of each type would be, and whether the format guard is clear. */
async function main() {
  const formats = await db.numberingFormat.findMany({ orderBy: { documentType: "asc" } });
  const sequences = await db.documentSequence.findMany();
  const byType = new Map<string, typeof sequences>();
  for (const seq of sequences) {
    byType.set(seq.documentType, [...(byType.get(seq.documentType) ?? []), seq]);
  }

  for (const format of formats) {
    const rows = byType.get(format.documentType) ?? [];
    const stale = rows.filter((r) => r.format !== null && r.format !== format.format);
    let next: string;
    try {
      next = await previewNumber(format.documentType);
    } catch (error) {
      next = `— ${error instanceof Error ? error.message.slice(0, 70) : "error"}`;
    }
    console.log(
      `${format.documentType.padEnd(20)} ${format.format.padEnd(24)} next: ${next}` +
        (stale.length > 0 ? `   ⚠ ${stale.length} counter(s) on an older format` : ""),
    );
  }

  const unstamped = sequences.filter((s) => s.format === null);
  console.log(
    `\n${sequences.length} counter(s); ${unstamped.length} with no format recorded` +
      (unstamped.length > 0 ? ` (${unstamped.map((s) => s.documentType).join(", ")})` : ""),
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
