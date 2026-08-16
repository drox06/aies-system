import { db } from "../src/lib/db";

/** Read-only: why the "Book in a delivery" panel might not be showing. */
async function main() {
  const perms = await db.permission.findMany({
    where: { key: { startsWith: "goods_receipt" } },
    include: { roles: { include: { role: { select: { key: true } } } } },
  });

  console.log(`goods_receipt permissions in the database: ${perms.length}`);
  for (const p of perms) {
    console.log(`  ${p.key} → ${p.roles.map((r) => r.role.key).join(", ") || "NO ROLES"}`);
  }

  const pos = await db.supplierPO.findMany({
    where: { deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  console.log(`\nSUPPLIER POs`);
  for (const po of pos) {
    console.log(`  ${po.number}  status=${po.status}  lines=${po.lines.length}`);
    for (const line of po.lines) {
      const outstanding = Number(line.quantity) - Number(line.qtyReceived);
      console.log(
        `    ${line.lineNo}. ${line.description}  ordered=${line.quantity.toString()} ` +
          `received=${line.qtyReceived.toString()} outstanding=${outstanding}`,
      );
    }
  }

  const format = await db.numberingFormat.findUnique({ where: { documentType: "goods_receipt" } });
  console.log(
    `\ngoods_receipt numbering format: ${format?.format ?? "MISSING — run npm run seed"}`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
