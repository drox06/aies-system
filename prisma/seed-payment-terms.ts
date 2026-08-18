import { db } from "../src/lib/db";
import { checkTermMilestones, type TermMilestone } from "../src/server/core/finance/billing-rules";

/**
 * specs/05-finance-billing.md §2's seed terms.
 *
 * ## Why these rows did not exist before
 *
 * `PaymentTerm` has been in the schema since module 02, and nothing ever created a row. A quotation
 * could reference a term and there were none to reference — so every quotation so far carries free
 * text where a term should be, and module 05 had nothing to bill from. Found while building the
 * billing schedule, which is the first thing that needed to read one.
 *
 * ## One definition, both shapes
 *
 * `downpaymentPct` and `balanceTrigger` are module 02's fields and its quotation document prints
 * from them. `milestones` is module 05's, and billing reads it. They describe the same commercial
 * fact, so they are **derived from one definition here** rather than typed twice — the schema comment
 * on `milestones` promises that, and this is where the promise is kept. Two hand-maintained copies
 * would drift, and the drift would be a quotation promising 50% up front against a schedule billing
 * 30%.
 *
 * ## Idempotent, and safe to run against live
 *
 * Upserts by `name`, which is unique. It updates the milestones of a term it already created —
 * deliberately, because that is how a correction reaches a term somebody is already quoting on —
 * and it never touches a term somebody added by hand, because it only knows these five names.
 *
 * Editing a term does **not** re-plan orders already scheduled: `BillingSchedule.termSnapshot`
 * freezes what each order agreed to. That is what makes running this safe.
 */

interface TermSeed {
  name: string;
  description: string;
  netDays: number;
  milestones: TermMilestone[];
}

const TERMS: TermSeed[] = [
  {
    name: "50/50 (50% DP, 50% on completion)",
    description:
      "Half on order, half when the work is finished and the closing documents are in. The company's " +
      "usual position on installation work.",
    netDays: 15,
    milestones: [
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance on completion", pct: "50", trigger: "on_project_close" },
    ],
  },
  {
    name: "30/70",
    description:
      "Thirty per cent on order to cover the principal's deposit, the balance on completion. Used " +
      "where AIES has to commit money to a supplier before anything ships.",
    netDays: 15,
    milestones: [
      { label: "Downpayment", pct: "30", trigger: "on_order" },
      { label: "Balance on completion", pct: "70", trigger: "on_project_close" },
    ],
  },
  {
    /**
     * Bills on the **signed** delivery receipt, not on despatch.
     *
     * §2 is explicit that "goods-only orders bill on the signed DR, not on despatch", and §13 of
     * module 04 is why: a delivery sits at `delivered_unsigned` until somebody at the customer signs,
     * and that signature is the artefact a collections conversation runs on. Billing on despatch
     * moves the invoice a few days earlier and gives away the only piece of paper that settles an
     * argument about whether the goods arrived.
     */
    name: "100% on delivery",
    description:
      "The whole amount once the customer has signed for the goods. Goods-only orders — nothing to " +
      "install, nothing to commission.",
    netDays: 30,
    milestones: [{ label: "Full amount on signed delivery", pct: "100", trigger: "on_dr_signed" }],
  },
  {
    name: "Net 30 after completion",
    description:
      "Nothing up front, everything thirty days after the project closes. The weakest cash position " +
      "the company offers; use it knowingly.",
    netDays: 30,
    milestones: [
      { label: "Full amount", pct: "100", trigger: "net_days_after_close", daysAfter: 30 },
    ],
  },
  {
    /**
     * Three milestones, each on a different event, which is what "progress billing" actually means:
     * money arrives as the work reaches points the customer can verify. The middle one bills on the
     * customer's own commissioning acceptance — §2 calls the T&C certificate a strong billing
     * trigger, and it is the strongest artefact this platform produces, because the customer's
     * engineer signed it.
     */
    name: "Progress billing",
    description:
      "Twenty on order, fifty when commissioning is accepted, thirty on close. For long jobs where " +
      "waiting for completion would fund the customer's project out of AIES's cash.",
    netDays: 15,
    milestones: [
      { label: "Mobilisation advance", pct: "20", trigger: "on_order" },
      { label: "On commissioning accepted", pct: "50", trigger: "on_tc_accepted" },
      { label: "Final on close-out", pct: "30", trigger: "on_project_close" },
    ],
  },
];

/** Module 02's two fields, derived from the milestones so they cannot disagree. */
function legacyFields(milestones: TermMilestone[]) {
  const upFront = milestones
    .filter((milestone) => milestone.trigger === "on_order")
    .reduce((sum, milestone) => sum + Number(milestone.pct), 0);

  const balance = milestones.filter((milestone) => milestone.trigger !== "on_order").at(-1);

  const BALANCE_PHRASES: Record<string, string> = {
    on_project_close: "on completion",
    on_dr_signed: "on delivery",
    on_delivery: "on delivery",
    on_tc_accepted: "on commissioning",
    on_installation: "on completion",
    net_days_after_close: "on invoice",
    on_supplier_order: "on invoice",
    on_order: "on invoice",
  };

  return {
    downpaymentPct: upFront.toFixed(4),
    balanceTrigger: balance ? (BALANCE_PHRASES[balance.trigger] ?? "on invoice") : null,
  };
}

async function main() {
  let created = 0;
  let updated = 0;

  for (const term of TERMS) {
    // Refuse to seed a term that could not be billed from. A broken seeded term is worse than a
    // missing one: somebody quotes on it, and the failure surfaces months later at billing.
    const check = checkTermMilestones(term.milestones);
    if (!check.ok) {
      throw new Error(`"${term.name}" is not billable: ${check.errors.join(" ")}`);
    }
    for (const warning of check.warnings) {
      console.warn(`  ${term.name}: ${warning}`);
    }

    const legacy = legacyFields(term.milestones);
    const existing = await db.paymentTerm.findUnique({ where: { name: term.name } });

    await db.paymentTerm.upsert({
      where: { name: term.name },
      update: {
        description: term.description,
        netDays: term.netDays,
        milestones: term.milestones as unknown as object[],
        ...legacy,
        isActive: true,
      },
      create: {
        name: term.name,
        description: term.description,
        netDays: term.netDays,
        milestones: term.milestones as unknown as object[],
        ...legacy,
        isActive: true,
      },
    });

    if (existing) updated += 1;
    else created += 1;
  }

  console.log(`Payment terms: ${created} created, ${updated} updated.`);
  for (const term of TERMS) {
    const shape = term.milestones.map((m) => `${m.pct}% ${m.trigger}`).join(" + ");
    console.log(`  ${term.name} — ${shape}, net ${term.netDays}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
