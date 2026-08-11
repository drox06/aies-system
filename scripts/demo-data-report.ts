import { db } from "../src/lib/db";

/** What hangs off what, so a delete is decided on facts rather than on record names. */
async function main() {
  const quotations = await db.quotation.findMany({
    select: {
      number: true,
      status: true,
      account: { select: { code: true, name: true } },
      inquiry: { select: { number: true } },
    },
    orderBy: { number: "asc" },
  });
  for (const q of quotations) {
    console.log(
      `QUOTE ${q.number} | ${q.status} | account ${q.account.code} | inquiry ${q.inquiry?.number ?? "—"}`,
    );
  }

  const pos = await db.customerPO.findMany({
    select: {
      poNumber: true,
      account: { select: { code: true } },
      inquiry: { select: { number: true } },
    },
  });
  for (const p of pos) {
    console.log(
      `PO ${p.poNumber} | account ${p.account.code} | inquiry ${p.inquiry?.number ?? "—"}`,
    );
  }

  const inquiries = await db.inquiry.findMany({
    select: { number: true, account: { select: { code: true } } },
    orderBy: { number: "asc" },
  });
  for (const i of inquiries) console.log(`INQ ${i.number} | account ${i.account?.code ?? "—"}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
