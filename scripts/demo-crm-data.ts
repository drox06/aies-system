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

  const inquiries = await db.inquiry.findMany({
    where: {
      OR: [
        { accountId: { in: ids } },
        { number: { startsWith: "INQ-" }, subject: { startsWith: DEMO_TAG } },
      ],
    },
    select: { id: true },
  });
  const inquiryIds = inquiries.map((i) => i.id);

  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });

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

  await seedInquiries(ea.id);

  console.log("\nDone. Accounts are owned by EA, accreditations by PD.");
  console.log("Certificate links will 404 — the file ids are placeholders, not real uploads.");
}

/**
 * specs/01-crm-inquiry.md §§3-5, positioned so each screen state is visible.
 *
 * Written straight to the table rather than through `createInquiryService`, because the service
 * refuses most of what needs demonstrating: it will not backdate an SLA into breach, and it will
 * not put an inquiry in `inspection_required` without walking the whole diagram. The point of demo
 * data is to *show* the end states, so it sets them.
 *
 * One consequence worth knowing before reading the screen: `slaEscalatedAt` is left null on the
 * overdue one, so the nightly sweep still has something to find.
 */
async function seedInquiries(ownerId: string) {
  const accounts = await db.customerAccount.findMany({
    where: { code: { startsWith: DEMO_TAG } },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  if (accounts.length === 0) return;

  const scenarios = [
    {
      subject: `${DEMO_TAG}Replace 2 x DN100 electromagnetic flow meters`,
      status: "new",
      receivedDaysAgo: 0,
      serviceType: "supply",
      note: "New, inside its SLA — the acknowledgement column shows a due date.",
    },
    {
      subject: `${DEMO_TAG}Pressure transmitter calibration, 12 units`,
      status: "new",
      receivedDaysAgo: 6,
      serviceType: "calibration",
      note: "New and overdue — shows OVERDUE, and the nightly sweep will escalate it to KJ and EA.",
    },
    {
      subject: `${DEMO_TAG}Install and commission chlorine dosing skid`,
      status: "evaluating",
      receivedDaysAgo: 3,
      acknowledgedDaysAgo: 3,
      serviceType: "installation",
      note: "Evaluating with the checklist unanswered — 'Hand to quotation' is blocked.",
    },
    {
      subject: `${DEMO_TAG}Retrofit level instrumentation, clarifier 3`,
      status: "inspection_required",
      receivedDaysAgo: 5,
      acknowledgedDaysAgo: 5,
      pausedDaysAgo: 2,
      serviceType: "installation",
      // The acknowledgement column reads "Acknowledged", *not* "Clock paused" — and that is
      // correct. Once an inquiry is acknowledged the §3 SLA is satisfied and there is nothing left
      // to pause. See docs/DECISIONS.md #21: with §3's own transition map, `inspection_required` is
      // only reachable after acknowledgement, so the pause cannot affect this clock. The open
      // request itself shows on the record page's inspection panel.
      note: "Parked on a site inspection — see the inspection panel on the record page.",
    },
  ];

  let sequence = 1;
  for (const [index, scenario] of scenarios.entries()) {
    const account = accounts[index % accounts.length]!;
    const inquiry = await db.inquiry.create({
      data: {
        // Not allocated through the numbering service: that would consume real INQ- sequence
        // numbers for throwaway data, and Spec.md §5 says numbers are never reused.
        number: `INQ-DEMO-${String(sequence++).padStart(4, "0")}`,
        subject: scenario.subject,
        description: "Demo record. Safe to delete with `npm run demo:crm -- --clean`.",
        accountId: account.id,
        ownerId,
        source: "phone",
        status: scenario.status,
        receivedAt: daysFromNow(-scenario.receivedDaysAgo),
        acknowledgedAt:
          scenario.acknowledgedDaysAgo === undefined
            ? null
            : daysFromNow(-scenario.acknowledgedDaysAgo),
        slaPausedAt:
          scenario.pausedDaysAgo === undefined ? null : daysFromNow(-scenario.pausedDaysAgo),
        estimatedValue: `${(index + 1) * 185000}`,
        items: {
          create: [
            {
              lineNo: 1,
              description: scenario.subject.replace(DEMO_TAG, ""),
              quantity: "2",
              unit: "unit",
              serviceType: scenario.serviceType,
            },
          ],
        },
      },
    });

    if (scenario.status === "inspection_required") {
      await db.inspectionRequest.create({
        data: {
          inquiryId: inquiry.id,
          purpose: "Confirm tank penetrations and cable routing before quoting",
          questions: "Is there an existing 4-20 mA loop back to the PLC, and what is its tag?",
          requiredOutputs: ["photos", "tag_list", "measurements"],
          windowStart: daysFromNow(3),
          windowEnd: daysFromNow(10),
          requestedById: ownerId,
        },
      });
    }

    console.log(`${inquiry.number}  ${scenario.subject}\n            ${scenario.note}`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
