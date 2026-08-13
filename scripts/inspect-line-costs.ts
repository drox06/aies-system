import { db } from "../src/lib/db";

/** What is actually stored, before changing what `unitCost` means. */
async function main() {
  const lines = await db.quotationLine.findMany({
    select: {
      lineNo: true,
      description: true,
      unitCost: true,
      costCurrency: true,
      costFxRate: true,
      quotation: { select: { number: true, currency: true, fxBufferPct: true } },
    },
    orderBy: { lineNo: "asc" },
  });

  console.log(`${lines.length} quotation line(s)`);
  for (const line of lines) {
    console.log(
      `  ${line.quotation.number} L${line.lineNo} | cost ${line.unitCost.toString()} ` +
        `${line.costCurrency} @ rate ${line.costFxRate.toString()} | quotation ${line.quotation.currency} ` +
        `buffer ${line.quotation.fxBufferPct.toString()}% | ${line.description.slice(0, 40)}`,
    );
  }
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
