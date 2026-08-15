import { db } from "../src/lib/db";

/** Every quotation and the counter behind it — read-only, before any renumbering decision. */
async function main() {
  const rows = await db.quotation.findMany({
    select: {
      number: true,
      revision: true,
      status: true,
      title: true,
      sentAt: true,
      deletedAt: true,
      account: { select: { name: true } },
    },
    orderBy: [{ number: "asc" }, { revision: "asc" }],
  });

  for (const q of rows) {
    console.log(
      `${q.number} rev${q.revision} | ${q.status.padEnd(16)} | sent ${
        q.sentAt ? q.sentAt.toISOString().slice(0, 10) : "—"
      } | ${q.deletedAt ? "DELETED" : "live   "} | ${q.account.name} | ${q.title.slice(0, 40)}`,
    );
  }

  const sequences = await db.documentSequence.findMany({
    where: { documentType: { startsWith: "quotation" } },
  });
  for (const s of sequences) {
    console.log(`counter ${s.documentType} scope ${s.scopeKey} = ${s.counter}`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
