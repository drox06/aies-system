import { db } from "../src/lib/db";
import { createStandaloneTicketService } from "../src/server/core/operations/ticket-service";
import {
  recordUnavailabilityService,
  scheduleTicketService,
} from "../src/server/core/operations/dispatch-service";
import {
  activateContractService,
  createContractService,
} from "../src/server/core/operations/renewal-service";
import {
  saveExpenseService,
  saveTimesheetService,
} from "../src/server/core/operations/timesheet-service";
import {
  completeResponseService,
  saveAnswersService,
  startResponseService,
} from "../src/server/core/operations/checklist-service";

/**
 * Sample records for the screens built in sessions 13–16, so they can be looked at populated.
 *
 * §13's delivery lane, §15's checklists, §16's renewals and contracts, §17's dispatch board. Every
 * one of them renders "nothing here" against the current database, which tells a reviewer almost
 * nothing about whether it works.
 *
 * **Guarded** — `ALLOW_DEMO_DATA=1`, docs/DECISIONS.md #76 — because it writes to whatever database
 * it is pointed at, and that is currently the live one.
 *
 * **Everything it creates is prefixed `Sample —`**, so `--remove` can find it again and so anybody
 * looking at a screen can tell at a glance what is real. The one exception is the maintenance
 * contract, which carries a real `AIESMC` number from the sequence; it is found by its account.
 *
 * ## Why it goes through the services
 *
 * Same reason as `sample-records.ts`: a row inserted directly has no number from the sequence, no
 * audit row, no events, and has passed none of the rules. It samples a screen rendering rather than
 * the system working, and the first thing it hides is whichever rule the real path would have failed.
 *
 * ## What it deliberately makes messy
 *
 * One technician is booked twice on the same day, and one is scheduled while on leave. A board with
 * no conflicts on it does not show whether the conflict banner works — and the banner is the reason
 * the board is worth having.
 */

const APPLY = process.env.ALLOW_DEMO_DATA === "1";
const REMOVE = process.argv.includes("--remove");
const MARK = "Sample —";

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const dayOnly = (days: number) => new Date(inDays(days).toISOString().slice(0, 10));

async function remove() {
  const tickets = await db.ticket.findMany({
    where: { title: { startsWith: MARK } },
    select: { id: true, accountId: true },
  });
  const ticketIds = tickets.map((t) => t.id);
  const accountIds = [...new Set(tickets.map((t) => t.accountId))];

  const responses = await db.checklistResponse.findMany({
    where: { ticketId: { in: ticketIds } },
    select: { id: true },
  });

  await db.checklistResponse.deleteMany({ where: { id: { in: responses.map((r) => r.id) } } });
  await db.timesheet.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.fieldExpense.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.deliveryTicketFlow.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });

  const contracts = await db.maintenanceContract.findMany({
    where: { account: { name: { startsWith: MARK } } },
    select: { id: true },
  });
  await db.maintenanceContract.deleteMany({ where: { id: { in: contracts.map((c) => c.id) } } });
  await db.equipment.deleteMany({ where: { description: { startsWith: MARK } } });
  await db.technicianAvailability.deleteMany({ where: { notes: { startsWith: MARK } } });

  /**
   * Accounts are found by name rather than through the tickets, so a partly-seeded run cleans up too.
   *
   * The first draft found accounts only via their tickets, and a run that failed *before* creating
   * any left an account and its site behind — then `customerAccount.deleteMany` failed on the site's
   * foreign key and reported nothing useful. Sites go first, and the account list is independent of
   * whether anything got as far as a ticket.
   */
  const sampleAccounts = await db.customerAccount.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  const sampleAccountIds = sampleAccounts.map((account) => account.id);

  await db.site.deleteMany({ where: { accountId: { in: sampleAccountIds } } });
  await db.equipment.deleteMany({ where: { accountId: { in: sampleAccountIds } } });
  await db.maintenanceContract.deleteMany({ where: { accountId: { in: sampleAccountIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: sampleAccountIds } } });

  await db.auditLog.deleteMany({
    where: { entityId: { in: [...ticketIds, ...accountIds, ...sampleAccountIds] } },
  });

  console.log(
    `Removed ${ticketIds.length} sample tickets and ${sampleAccountIds.length} sample account(s).`,
  );
}

async function main() {
  if (REMOVE) {
    if (!APPLY) {
      console.log("Refusing: set ALLOW_DEMO_DATA=1 to write to this database.");
      return;
    }
    await remove();
    return;
  }

  if (!APPLY) {
    console.log(
      "Refusing: set ALLOW_DEMO_DATA=1 to seed sample records. This writes to whatever database " +
        "DATABASE_URL points at, which is currently the live one.",
    );
    return;
  }

  // Real people, so the dispatch board has rows somebody recognises. Assigning them a sample ticket
  // is harmless and removable; inventing fake technicians would mean fake accounts on a live system.
  const people = await db.user.findMany({
    where: { email: { in: ["dj@aieselectromech.com", "pd@aieselectromech.com"] } },
    select: { id: true, name: true, email: true },
  });
  const dj = people.find((p) => p.email.startsWith("dj"));
  const pd = people.find((p) => p.email.startsWith("pd"));
  if (!dj || !pd) {
    console.log("Could not find DJ and PD. Run the seed first.");
    return;
  }

  const actor = { actorId: dj.id, actorLabel: `${dj.name} (sample data)` };

  const account = await db.customerAccount.create({
    data: {
      code: `SAMPLE-${Date.now().toString(36).toUpperCase().slice(-6)}`,
      name: `${MARK} Batangas Refinery`,
      ownerId: dj.id,
    },
  });

  const site = await db.site.create({
    data: {
      accountId: account.id,
      name: "Tank farm, Bay 3",
      address: { street: "Refinery Road", barangay: "Simlong", city: "Batangas City" },
      accessNotes: "Gate 2. Safety induction at the guardhouse, bring two IDs.",
    },
  });

  // ---- §16: an installed base with dates that are about to matter -------------------------------

  const meter = await db.equipment.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      description: `${MARK} Ultrasonic flowmeter, Bay 3 outlet`,
      tagNumber: "FT-3201",
      serialNumber: "SN-88134",
      manufacturer: "Krohne",
      modelNumber: "OPTISONIC 3400",
      status: "active",
      // Inside §16's 60-day calibration window, so the renewals screen has something urgent.
      calibrationDueAt: inDays(18),
      nextPMDueAt: inDays(40),
    },
  });

  const transmitter = await db.equipment.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      description: `${MARK} Pressure transmitter, feedwater line`,
      tagNumber: "PT-1180",
      serialNumber: "SN-44902",
      manufacturer: "Yokogawa",
      modelNumber: "EJA530E",
      status: "active",
      // Warranty ending inside the window, and a service date already past — two different reasons.
      warrantyStart: inDays(-330),
      warrantyEnd: inDays(35),
      nextPMDueAt: inDays(-12),
    },
  });

  const contract = await createContractService(actor, {
    accountId: account.id,
    siteId: site.id,
    startDate: dayOnly(-320),
    endDate: dayOnly(45), // inside §16's 90-day renewal window
    visitsPerYear: 4,
    equipmentIds: [meter.id, transmitter.id],
    contractValue: 18_000_000, // ₱180,000
  });
  await activateContractService(actor, { contractId: contract.id });

  // ---- §17: a week with something on it, and something wrong with it ----------------------------

  const installation = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "installation",
    title: `${MARK} Install replacement flowmeter, Bay 3`,
    scopeOfWork:
      "Remove FT-3201, install the replacement unit, loop check against the DCS and hand back.",
    justification: "Sample record for the dispatch board.",
    requiredByDate: inDays(6),
  });

  const callback = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "after_sales",
    subType: "corrective",
    title: `${MARK} Investigate PT-1180 reading drift`,
    scopeOfWork: "Customer reports the feedwater pressure reading drifting high. Investigate.",
    justification: "Sample record — a second job the same week.",
    priority: "high",
    requiredByDate: inDays(4),
  });

  const survey = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "installation",
    title: `${MARK} Pre-shutdown survey, Bay 3`,
    scopeOfWork: "Walk the bay ahead of the October shutdown and list what needs isolating.",
    justification: "Sample record — a job with nobody assigned yet.",
  });

  const delivery = await createStandaloneTicketService(actor, {
    accountId: account.id,
    siteId: site.id,
    type: "delivery",
    title: `${MARK} Deliver 2 sets pressure gauges`,
    scopeOfWork: "Take them to the customer and get the receipt signed.",
    justification: "Sample record for delivery mode.",
    requiredByDate: inDays(3),
  });

  // Two jobs, one technician, same day — the conflict the board exists to show.
  await scheduleTicketService(actor, {
    ticketId: installation.id,
    scheduledStart: inDays(2),
    scheduledEnd: inDays(3),
    assignedLeadId: dj.id,
  });
  await scheduleTicketService(actor, {
    ticketId: callback.id,
    scheduledStart: inDays(2),
    assignedLeadId: dj.id,
  });

  // And one scheduled straight into somebody's leave.
  const leave = await recordUnavailabilityService(actor, {
    userId: pd.id,
    fromDate: dayOnly(4),
    toDate: dayOnly(6),
    kind: "leave",
    notes: `${MARK} annual leave`,
  });
  void leave;

  await scheduleTicketService(actor, {
    ticketId: delivery.id,
    scheduledStart: inDays(5),
    assignedLeadId: pd.id,
  });

  // Scheduled, nobody on it — the board's third case.
  await scheduleTicketService(actor, { ticketId: survey.id, scheduledStart: inDays(4) });

  // ---- §15: a checklist actually filled in ------------------------------------------------------

  const response = await startResponseService(actor, {
    templateKey: "mobilization_readiness",
    ticketId: installation.id,
  });

  await saveAnswersService(actor, {
    responseId: response.id,
    answers: {
      gate_pass: { value: "pass" },
      work_permit: { value: "pass" },
      hot_work_permit: { na: true },
      safety_induction: { value: "pass" },
      materials_issued: { value: "pass" },
      tools_complete: {
        value: "fail",
        cause: "Clamp-on transducer set still with the previous job",
        action: "Collected from the Cavite crew on the way out",
      },
      ppe_complete: { value: "pass" },
      cash_advance: { na: true },
    },
  });
  await completeResponseService(actor, {
    responseId: response.id,
    signedByName: "D. Javier",
    signedByPosition: "Operations Manager",
  });

  // ---- §16: hours and spend against the job -----------------------------------------------------

  await saveTimesheetService(actor, {
    ticketId: installation.id,
    date: dayOnly(-1),
    regularHours: 8,
    travelHours: 3,
    // Standby, so §8's argument is visible on a real record rather than only in a test.
    standbyHours: 2,
    activity: "Travel to Batangas, waited for permit, started removal",
  });

  /**
   * Under §16's receipt threshold, deliberately.
   *
   * The first draft of this script tried to seed ₱2,450 of diesel and was refused — "anything over
   * ₱500.00 needs its receipt attached before it can be claimed" — which is the rule working exactly
   * as written. Rather than fake a receipt file that would 404 when somebody clicked it, the sample
   * stops below the line and the over-threshold case is left for a reviewer to try by hand, with a
   * real photograph. That is a better test of it than a seeded row could ever be.
   */
  await saveExpenseService(actor, {
    ticketId: installation.id,
    date: dayOnly(-1),
    category: "toll_parking",
    amount: 42_000, // ₱420
    description: "SLEX and STAR tolls",
  });

  await saveExpenseService(actor, {
    ticketId: installation.id,
    date: dayOnly(-1),
    category: "meals",
    amount: 36_000, // ₱360
    description: "Crew lunch on site",
  });

  console.log(`Seeded sample records on ${account.code} — ${account.name}:`);
  console.log("  /dispatch     2 jobs on one technician the same day, 1 into leave, 1 unassigned");
  console.log("  /renewals     contract ending in 45 days, calibration in 18, warranty in 35,");
  console.log("                one item 12 days past its service date");
  console.log("  /contracts    one active contract covering 2 items");
  console.log(`  /tickets      ${installation.number} carries the checklist, hours and expenses`);
  console.log(`  /field        ${delivery.number} is a delivery waiting to go out`);
  console.log(
    "\nRemove them again with:  ALLOW_DEMO_DATA=1 npx tsx scripts/sample-records-dispatch.ts --remove",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
