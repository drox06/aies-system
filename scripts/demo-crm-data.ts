/**
 * Demo CRM data, for looking at the screens and exercising the nightly sweeps.
 *
 *   npm run demo:crm          create
 *   npm run demo:crm -- --clean   remove everything it created
 *
 * Every row it creates is tagged with DEMO_TAG in the account code, so cleanup is exact and it can
 * never remove a real record. This is a development aid — do not run it against production.
 *
 * The dates are the point. Each accreditation is positioned at a specific day relative to today so
 * that the sweeps in accreditation-renewal.ts actually fire: they trigger on the *exact* day a
 * threshold is crossed, so "roughly a month out" would produce nothing and look like a bug.
 */
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // CI/production supply real env vars directly.
}

const db = new PrismaClient();
const DEMO_TAG = "DEMO-";
const DAY_MS = 86_400_000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

async function clean() {
  const accounts = await db.customerAccount.findMany({
    where: { code: { startsWith: DEMO_TAG } },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) {
    console.log("Nothing to clean.");
    return;
  }

  const records = await db.accreditationRecord.findMany({
    where: { accountId: { in: ids } },
    select: { id: true },
  });
  const recordIds = records.map((r) => r.id);

  await db.notification.deleteMany({ where: { entityId: { in: recordIds } } });
  await db.approvalAction.deleteMany({ where: { request: { entityId: { in: recordIds } } } });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: recordIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...recordIds, ...ids] } } });
  await db.accreditationRecord.deleteMany({ where: { accountId: { in: ids } } });
  await db.contact.deleteMany({ where: { accountId: { in: ids } } });
  await db.site.deleteMany({ where: { accountId: { in: ids } } });
  await db.customerAccount.deleteMany({ where: { id: { in: ids } } });

  console.log(`Removed ${ids.length} demo accounts and everything hanging off them.`);
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean();
    return;
  }

  // Owned by whoever will be looking at the screens, so record scoping does not hide the rows from
  // them. PD owns the accreditations because §5b makes that their work.
  const pd = await db.user.findFirst({ where: { email: "pd@aieselectromech.com" } });
  const ea = await db.user.findFirst({ where: { email: "ea@aieselectromech.com" } });
  if (!pd || !ea) {
    throw new Error("Seeded users not found — run `npm run seed` first.");
  }

  await clean();

  const scenarios: {
    code: string;
    name: string;
    industry: string;
    accountStatus: string;
    accreditation?: {
      status: string;
      expiresInDays: number | null;
      certificate?: boolean;
      acknowledgedDaysAgo?: number;
    };
    note: string;
  }[] = [
    {
      code: `${DEMO_TAG}0001`,
      name: "Maynilad Water Services Inc.",
      industry: "Water utility",
      accountStatus: "active",
      accreditation: { status: "accredited", expiresInDays: 300, certificate: true },
      note: "Healthy — no flag on the account.",
    },
    {
      code: `${DEMO_TAG}0002`,
      name: "Batangas Power Generation Corp.",
      industry: "Power generation",
      accountStatus: "active",
      // Exactly 30 days out: the nightly sweep fires the "Prepare renewal" notification to PD.
      accreditation: { status: "accredited", expiresInDays: 30, certificate: true },
      note: "Renewal due in exactly 30 days — the sweep will notify PD.",
    },
    {
      code: `${DEMO_TAG}0003`,
      name: "San Miguel Food Processing",
      industry: "Food manufacturing",
      accountStatus: "active",
      // Still says accredited, but the certificate expired a week ago. The derived status must
      // override the stored one and the account must read as blocking.
      accreditation: { status: "accredited", expiresInDays: -7, certificate: true },
      note: "Says accredited, but the certificate expired 7 days ago — should read as EXPIRED.",
    },
    {
      code: `${DEMO_TAG}0004`,
      name: "Cavite Industrial Estate",
      industry: "Industrial park",
      accountStatus: "blacklisted",
      accreditation: { status: "renewal_due", expiresInDays: 20, certificate: true },
      note: "Blacklisted — acknowledging the renewal should require EA approval.",
    },
    {
      code: `${DEMO_TAG}0005`,
      name: "Laguna Textile Mills",
      industry: "Textiles",
      accountStatus: "active",
      // Acknowledged 30 days ago with no new certificate since: the stalled sweep escalates to
      // EA and KJ.
      accreditation: {
        status: "preparing",
        expiresInDays: 5,
        certificate: true,
        acknowledgedDaysAgo: 30,
      },
      note: "Acknowledged 30 days ago, still not done — the sweep will escalate to EA and KJ.",
    },
    {
      code: `${DEMO_TAG}0006`,
      name: "Zambales Mining Services",
      industry: "Mining",
      accountStatus: "active",
      note: "No accreditation record at all — should show 'Not accredited'.",
    },
  ];

  for (const s of scenarios) {
    const account = await db.customerAccount.create({
      data: {
        code: s.code,
        name: s.name,
        industry: s.industry,
        accountType: "customer",
        status: s.accountStatus,
        ownerId: ea.id,
        tin: `${Math.floor(100 + Math.random() * 899)}-000-000-000`,
      },
    });

    await db.contact.create({
      data: {
        accountId: account.id,
        firstName: "Procurement",
        lastName: s.name.split(" ")[0] ?? "Lead",
        position: "Procurement Officer",
        mobile: "0917 000 0000",
        email: `procurement@${s.name
          .toLowerCase()
          .replace(/[^a-z]/g, "")
          .slice(0, 12)}.com.ph`,
        isPrimary: true,
      },
    });

    if (s.accreditation) {
      const a = s.accreditation;
      await db.accreditationRecord.create({
        data: {
          accountId: account.id,
          status: a.status,
          ownerId: pd.id,
          expiresAt: a.expiresInDays === null ? null : daysFromNow(a.expiresInDays),
          certificateFileId: a.certificate ? "demo-certificate-file" : null,
          certificateUploadedAt: a.certificate ? daysFromNow(-330) : null,
          referenceNumber: `ACR-${account.code}`,
          renewalAcknowledgedAt:
            a.acknowledgedDaysAgo === undefined ? null : daysFromNow(-a.acknowledgedDaysAgo),
          renewalAcknowledgedBy: a.acknowledgedDaysAgo === undefined ? null : pd.id,
        },
      });
    }

    console.log(`${account.code}  ${s.name}\n            ${s.note}`);
  }

  console.log("\nDone. Accounts are owned by EA, accreditations by PD.");
  console.log("Certificate links will 404 — the file ids are placeholders, not real uploads.");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
