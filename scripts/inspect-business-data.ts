import { db } from "../src/lib/db";

/**
 * A read-only inventory of the business records in this database.
 *
 * Written for one question — "what would 'remove the seeded data' actually delete?" — and kept
 * because that question recurs before every destructive step. It writes nothing.
 */
async function main() {
  const users = await db.user.findMany({
    select: { id: true, name: true, email: true },
    orderBy: { email: "asc" },
  });
  const nameById = new Map(users.map((u) => [u.id, `${u.name} <${u.email}>`]));
  const label = (id: string | null | undefined) => (id ? (nameById.get(id) ?? id) : "—");

  const accounts = await db.customerAccount.findMany({
    select: { id: true, code: true, name: true, ownerId: true, createdAt: true },
    orderBy: { code: "asc" },
  });
  const inquiries = await db.inquiry.findMany({
    select: { id: true, number: true, subject: true, status: true, ownerId: true },
    orderBy: { number: "asc" },
  });
  const quotations = await db.quotation.findMany({
    select: { id: true, number: true, revision: true, status: true, preparedById: true },
    orderBy: { number: "asc" },
  });
  const principals = await db.principalProspect.findMany({
    select: { id: true, companyName: true, stage: true, ownerId: true },
  });
  const pos = await db.customerPO.findMany({ select: { id: true, poNumber: true } });
  const accreditations = await db.accreditationRecord.count();
  const files = await db.fileObject.count({ where: { deletedAt: null } });

  console.log(`\nUSERS (${users.length})`);
  for (const u of users) console.log(`  ${u.name.padEnd(16)} ${u.email}`);

  console.log(`\nCUSTOMER ACCOUNTS (${accounts.length})`);
  for (const a of accounts)
    console.log(`  ${a.code.padEnd(10)} ${a.name} — owner ${label(a.ownerId)}`);

  console.log(`\nINQUIRIES (${inquiries.length})`);
  for (const i of inquiries) {
    console.log(
      `  ${i.number.padEnd(14)} ${i.status.padEnd(18)} ${i.subject} — owner ${label(i.ownerId)}`,
    );
  }

  console.log(`\nQUOTATIONS (${quotations.length})`);
  for (const q of quotations) {
    console.log(
      `  ${q.number.padEnd(16)} rev${q.revision} ${q.status.padEnd(16)} — by ${label(q.preparedById)}`,
    );
  }

  console.log(`\nPRINCIPAL PROSPECTS (${principals.length})`);
  for (const pr of principals)
    console.log(`  ${pr.companyName} — ${pr.stage} — owner ${label(pr.ownerId)}`);

  console.log(`\nCUSTOMER POs (${pos.length})`);
  for (const po of pos) console.log(`  ${po.poNumber}`);

  console.log(`\nOTHER: accreditation records ${accreditations}, stored files ${files}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
