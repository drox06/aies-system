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

  const principals = await db.principalProspect.findMany({
    where: { companyName: { startsWith: DEMO_TAG } },
    select: { id: true },
  });
  const principalIds = principals.map((p) => p.id);
  await db.notification.deleteMany({ where: { entityId: { in: principalIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: principalIds } } });
  await db.principalProspect.deleteMany({ where: { id: { in: principalIds } } });

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
        // Backdated so §6's "accounts not contacted in 60 days" has something to find. The rule
        // only considers accounts older than the window — a customer added this morning is not
        // neglected — so demo accounts created today could never appear on that list, which made
        // My Day's most important section look broken when it was working correctly.
        createdAt: daysFromNow(-120),
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
  await seedPrincipals(ea.id);
  await backfillSearchIndex();

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

/**
 * specs/01-crm-inquiry.md §5c, positioned so the board shows something in most columns and both
 * expiry warnings are visible.
 */
async function seedPrincipals(ownerId: string) {
  const scenarios = [
    {
      companyName: `${DEMO_TAG}Krohne Messtechnik`,
      country: "Germany",
      productLines: ["Electromagnetic flow meters", "Ultrasonic flow meters"],
      stage: "appointed",
      agreementDays: 300,
      priceListDays: 120,
      note: "Appointed and healthy.",
    },
    {
      companyName: `${DEMO_TAG}Samson Controls`,
      country: "Germany",
      productLines: ["Control valves", "Positioners"],
      stage: "appointed",
      agreementDays: 45,
      // Lapsed: the board should say "Price list lapsed" in red, and §5c calls costing from it a
      // margin incident waiting to happen.
      priceListDays: -10,
      note: "Appointed, but the price list lapsed 10 days ago — must read as unsafe to quote.",
    },
    {
      companyName: `${DEMO_TAG}Yokogawa Southeast Asia`,
      country: "Singapore",
      productLines: ["Pressure transmitters", "Temperature transmitters"],
      stage: "agreement_draft",
      agreementDays: null,
      priceListDays: null,
      note: "Agreement being drafted — appointing should be refused until one is attached.",
    },
    {
      companyName: `${DEMO_TAG}Endress+Hauser`,
      country: "Switzerland",
      productLines: ["Level instruments", "Analytical instruments"],
      stage: "samples_pricing",
      agreementDays: null,
      priceListDays: null,
      note: "Mid-pipeline.",
    },
    {
      companyName: `${DEMO_TAG}Azbil Philippines`,
      country: "Philippines",
      productLines: ["Burner controls"],
      stage: "dormant",
      agreementDays: null,
      priceListDays: null,
      note: "Parked — should sit under 'Declined and dormant', revivable.",
    },
  ];

  for (const s of scenarios) {
    const prospect = await db.principalProspect.create({
      data: {
        companyName: s.companyName,
        country: s.country,
        productLines: s.productLines,
        stage: s.stage,
        ownerId,
        targetIndustries: ["Water", "Power"],
        estimatedOpportunity: "2500000",
        exclusivity: s.stage === "appointed" ? "territory" : "none",
        distributorAgreementFileId: s.agreementDays === null ? null : "demo-agreement-file",
        agreementSignedAt: s.agreementDays === null ? null : daysFromNow(-365),
        agreementExpiresAt: s.agreementDays === null ? null : daysFromNow(s.agreementDays),
        priceListFileId: s.priceListDays === null ? null : "demo-pricelist-file",
        priceListValidUntil: s.priceListDays === null ? null : daysFromNow(s.priceListDays),
      },
    });
    console.log(`${prospect.companyName}\n            ${s.note}`);
  }
}

/**
 * Makes everything the script created findable from Ctrl+K.
 *
 * Accounts are indexed on create by the service now, but these rows are written straight to the
 * table (see seedInquiries for why), so nothing would index them.
 */
async function backfillSearchIndex() {
  const accounts = await db.customerAccount.findMany({
    where: { code: { startsWith: DEMO_TAG }, deletedAt: null },
    select: { id: true, code: true, name: true, industry: true },
  });
  for (const account of accounts) {
    await db.searchIndex.upsert({
      where: { entityType_entityId: { entityType: "CustomerAccount", entityId: account.id } },
      update: {},
      create: {
        entityType: "CustomerAccount",
        entityId: account.id,
        title: `${account.code} — ${account.name}`,
        body: account.industry ?? "",
        href: `/crm/accounts/${account.id}`,
      },
    });
  }

  const inquiries = await db.inquiry.findMany({
    where: { number: { startsWith: "INQ-DEMO" }, deletedAt: null },
    select: { id: true, number: true, subject: true },
  });
  for (const inquiry of inquiries) {
    await db.searchIndex.upsert({
      where: { entityType_entityId: { entityType: "Inquiry", entityId: inquiry.id } },
      update: {},
      create: {
        entityType: "Inquiry",
        entityId: inquiry.id,
        title: `${inquiry.number} — ${inquiry.subject}`,
        body: "",
        href: `/crm/inquiries/${inquiry.id}`,
      },
    });
  }

  console.log(
    `\nIndexed ${accounts.length} accounts and ${inquiries.length} inquiries for Ctrl+K.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
