import { db } from "../src/lib/db";
import { upsertEquipmentService } from "../src/server/core/operations/warranty-service";

/**
 * Three pieces of installed equipment, positioned so §11's warranty gate can be walked.
 *
 * ## Why three
 *
 * The gate's whole job is deciding **who pays**, and that decision has three shapes. Seeding one
 * piece of equipment would let somebody walk the happy path and conclude the gate works, which is
 * how §11 has stayed unwalked while looking finished.
 *
 *   - **Comfortably in warranty.** Installed two months ago on a twelve-month term. A claim here
 *     should read as covered without anybody arguing.
 *   - **Out of warranty by three weeks.** The interesting one. The dates say chargeable; the person
 *     answering the phone may still say goodwill, and §11 lets them — with a reason, which is the
 *     point of the override.
 *   - **Eleven days from expiry.** What the 90-day expiry sweep is for, and a plausible "get them to
 *     raise it now" conversation.
 *
 * ## What it does not do
 *
 * No claims are raised. A claim carries a fault description, a coverage decision and an attribution,
 * and every one of those is a judgement somebody makes while reading the equipment record — which is
 * exactly what the walkthrough is for. Seeding them would pre-decide the thing being tested.
 *
 * Equipment goes through `upsertEquipmentService` rather than a direct write, so the records carry
 * real numbering and a real audit trail.
 *
 * ## Guarded, prefixed, removable
 *
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-warranty.ts
 *   $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-warranty.ts --remove
 */

const MARK = "WARRANTY";
const DAY = 24 * 60 * 60 * 1000;

async function requireActor() {
  const user = await db.user.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (!user) throw new Error("No active user to act as. Run the seed first.");
  return { actorId: user.id, actorLabel: user.name };
}

async function remove() {
  const accounts = await db.customerAccount.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) {
    console.log("Nothing to remove.");
    return;
  }

  /*
    Claims, and the tickets they raise. See DECISIONS #126 — a removal must delete what the seed
    *becomes*, not what it wrote.

    This script cited #126 in a comment and then made the same mistake anyway: an in-warranty claim
    raises an after_sales ticket, so walking the gate leaves tickets behind that the account cannot
    be deleted around. Citing a lesson is not applying it.
  */
  const ticketIds = (
    await db.ticket.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })
  ).map((ticket) => ticket.id);

  await db.warrantyClaim.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.equipment.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.site.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });

  console.log(`Removed ${accountIds.length} ${MARK} account(s) and everything under them.`);
}

async function main() {
  if (process.argv.includes("--remove")) {
    await remove();
    return;
  }

  if (process.env.ALLOW_DEMO_DATA !== "1") {
    throw new Error(
      "Refusing to write sample data. Set ALLOW_DEMO_DATA=1 if this is really what you want.",
    );
  }

  const actor = await requireActor();

  const existing = await db.customerAccount.findFirst({ where: { name: { startsWith: MARK } } });
  if (existing) {
    console.log(`${MARK} account already exists. Run with --remove first to rebuild it.`);
    return;
  }

  const account = await db.customerAccount.create({
    data: {
      code: `WR-${Date.now().toString().slice(-8)}`,
      name: `${MARK} San Pascual Bottling`,
      ownerId: actor.actorId,
      accountType: "customer",
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Line 3, filling hall",
      address: {
        line1: "San Pascual Industrial Estate",
        barangay: "Barangay Poblacion",
        city: "San Pascual",
        province: "Batangas",
        postalCode: "4204",
      },
      accessNotes: "Report to the QA office. Hairnet and boots inside the filling hall.",
    },
  });

  const now = Date.now();

  const inWarranty = await upsertEquipmentService(actor, {
    accountId: account.id,
    siteId: site.id,
    description: "DN80 electromagnetic flowmeter, syrup line",
    serialNumber: "EH-77201144",
    tagNumber: "FT-3011",
    manufacturer: "Endress+Hauser",
    modelNumber: "Promag H 300",
    installedAt: new Date(now - 60 * DAY),
    commissionedAt: new Date(now - 58 * DAY),
    warrantyStart: new Date(now - 58 * DAY),
    warrantyEnd: new Date(now + 307 * DAY),
    warrantyTerms: "12 months from commissioning, parts and labour.",
    location: "Line 3, syrup room",
  });

  const justExpired = await upsertEquipmentService(actor, {
    accountId: account.id,
    siteId: site.id,
    description: "DN50 pneumatic control valve, CIP return",
    serialNumber: "SAM-4412093",
    tagNumber: "CV-3042",
    manufacturer: "Samson",
    modelNumber: "3241",
    installedAt: new Date(now - 400 * DAY),
    commissionedAt: new Date(now - 396 * DAY),
    warrantyStart: new Date(now - 396 * DAY),
    warrantyEnd: new Date(now - 21 * DAY),
    warrantyTerms: "12 months from commissioning, parts only.",
    location: "Line 3, CIP skid",
  });

  const expiringSoon = await upsertEquipmentService(actor, {
    accountId: account.id,
    siteId: site.id,
    description: "Conductivity analyser, CIP strength",
    serialNumber: "MT-9930188",
    tagNumber: "AT-3055",
    manufacturer: "Mettler Toledo",
    modelNumber: "M400",
    installedAt: new Date(now - 354 * DAY),
    commissionedAt: new Date(now - 354 * DAY),
    warrantyStart: new Date(now - 354 * DAY),
    warrantyEnd: new Date(now + 11 * DAY),
    warrantyTerms: "12 months from commissioning, parts and labour.",
    location: "Line 3, CIP skid",
  });

  console.log("");
  console.log(`Built ${MARK} — three instruments for §11's gate.`);
  console.log("");
  console.log(`  Account   ${account.name}`);
  console.log(`  Site      ${site.name}`);
  console.log("");
  console.log(
    `  ${inWarranty.tagNumber}  in warranty, 307 days left   — ${inWarranty.description}`,
  );
  console.log(
    `  ${justExpired.tagNumber}  OUT of warranty by 21 days   — ${justExpired.description}`,
  );
  console.log(
    `  ${expiringSoon.tagNumber}  expires in 11 days           — ${expiringSoon.description}`,
  );
  console.log("");
  console.log("No claims are seeded — raising one is the thing being walked.");
  console.log(
    `Take it out with:  $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-warranty.ts --remove`,
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
