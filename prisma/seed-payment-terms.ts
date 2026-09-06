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
 * ## docs/DECISIONS.md #184 — the company's own eight terms, replacing the original five
 *
 * The original five (`50/50`, `30/70`, `100% on delivery`, `Net 30 after completion`, `Progress
 * billing`) were a reasonable starting guess, made before the company had walked a real deal through
 * the platform end to end. Having done that, EA gave eight terms with the exact billing behaviour
 * each one needs — three of them ("100% Payment on Delivery", the two 50/50s' balance, "30/70"'s two
 * balances) bill on a person's judgement that the work is ready, not on a domain event, which is what
 * the `manual` trigger in `billing-rules.ts` exists for.
 *
 * Two of the eight are deliberately **not** rows here:
 *
 * - **"Net __ days after completion"** needs a day count nobody can guess in advance — `quotation`'s
 *   picker creates (or reuses) the specific-numbered term on the fly via
 *   `getOrCreateNetDaysTermService`, rather than this file guessing which counts to pre-seed.
 * - **"Others"** has no fixed shape at all — the whole point is that the deal does not match any of
 *   the other seven. It carries no milestones and is never a row; the quotation's own free-text
 *   `paymentTermsText` is what `paymentTermsClause` prints for it (see terms.ts), and it is billed
 *   entirely by hand, ad hoc, exactly as an order with no billing schedule already can be today.
 *
 * The original five are **retired below, not deleted** — `RETIRED_TERM_NAMES` — because a quotation
 * that already agreed to one of them is a real, signed contract, and unpicking that from underneath
 * it would be worse than leaving an inactive row nobody can newly select. `isActive: false` is exactly
 * what already keeps §130's stray test fixtures out of the picker without touching what they point
 * at.
 *
 * ## Idempotent, and safe to run against live
 *
 * Upserts by `name`, which is unique. It updates the milestones of a term it already created —
 * deliberately, because that is how a correction reaches a term somebody is already quoting on —
 * and it never touches a term somebody added by hand under a different name.
 *
 * Editing a term does **not** re-plan orders already scheduled: `BillingSchedule.termSnapshot`
 * freezes what each order agreed to. That is what makes running this safe.
 */

/** The original five, switched off rather than removed — see the module comment above. */
const RETIRED_TERM_NAMES = [
  "50/50 (50% DP, 50% on completion)",
  "30/70",
  "100% on delivery",
  "Net 30 after completion",
  "Progress billing",
];

interface TermSeed {
  name: string;
  description: string;
  netDays: number;
  milestones: TermMilestone[];
}

const TERMS: TermSeed[] = [
  {
    name: "100% Advanced Payment (Supply and Delivery only)",
    description:
      "The whole amount up front, before the goods ship. For a job that is nothing but supply and " +
      "delivery — once it is delivered there is nothing left to do or to bill.",
    netDays: 15,
    milestones: [{ label: "Full payment on order", pct: "100", trigger: "on_order" }],
  },
  {
    /**
     * Billing-identical to the term above — both are 100% on order. The reason it is a second, named
     * term rather than one person choosing to add a note is discoverability: whoever raises the ticket
     * afterward has to give it an installation/new_project/after_sales type for a `Project` to exist
     * at all (`ticketNeedsProject`), and a payment term that says so by name is far more likely to be
     * read than a instruction buried in a manual. Paid in full is not the same fact as finished — this
     * term exists so the two do not get conflated at the moment work is scheduled.
     */
    name: "100% Advanced Payment (Supply with subsequent activity)",
    description:
      "The whole amount up front, same as supply-only — but there is still installation, testing or " +
      "commissioning to do afterward. Being paid in full does not mean the job is finished: raise the " +
      "follow-on work as an installation ticket so the project and its close-out are still tracked, " +
      "and the budget stays visible even though nothing more will ever be billed against it.",
    netDays: 15,
    milestones: [{ label: "Full payment on order", pct: "100", trigger: "on_order" }],
  },
  {
    /**
     * The one term with no downpayment milestone at all — its single milestone bills 100%, and it
     * only becomes billable when a person releases it (`manual`), not on an event. Unlike every other
     * `manual` milestone in this file, `autoRaiseOnRelease` is set: releasing it *is* finance's answer
     * to "are we ready to bill this", so the statement is raised and issued in the same act rather
     * than waiting for a second person to notice it is ready. Delivery itself waits for the customer's
     * own confirmation that payment is in hand plus their preferred date, which is what schedules the
     * delivery ticket — see `releaseMilestoneService` and `recordCustomerBillingReplyService`.
     */
    name: "100% Payment on Delivery",
    description:
      "Nothing is billed until AIES is actually ready to send the goods. Finance releases the bill " +
      "when the order is ready to go out; delivery itself waits for the customer's confirmation that " +
      "payment is in hand and their preferred delivery date, which is what schedules the delivery " +
      "ticket.",
    netDays: 15,
    milestones: [
      {
        label: "Full payment, released when ready to bill",
        pct: "100",
        trigger: "manual",
        autoRaiseOnRelease: true,
      },
    ],
  },
  {
    /**
     * Two independent balances, not one 70% of the order. EA's own worked example: a ₱100 goods line
     * and a ₱100 installation line are not billed as "30% then 70% of ₱200" — the 30% downpayment
     * covers both lines at once, and what is left is two fixed 35%-of-the-whole-order balances, one
     * per line type, each on its own trigger. Both balances are `manual`: the goods balance is
     * released when supply and delivery is confirmed ready to bill, the installation balance when
     * operations confirms the work is actually done — see the finance/operations "ready to bill"
     * exchange this term is why it exists.
     */
    name: "30% Downpayment, 70% Progress Billing",
    description:
      "Thirty per cent on order to let procurement and installation both proceed. What remains is two " +
      "fixed 35% balances — one for supply and delivery, one for installation — each released only " +
      "when that half of the job is actually confirmed ready, not by a flat percentage of value.",
    netDays: 15,
    milestones: [
      { label: "Downpayment", pct: "30", trigger: "on_order" },
      { label: "Supply and delivery balance", pct: "35", trigger: "manual" },
      { label: "Installation balance", pct: "35", trigger: "manual" },
    ],
  },
  {
    name: "50% Downpayment, 50% On Delivery",
    description:
      "Half on order, half released when delivery is confirmed ready to bill. Used for supply-and-" +
      "delivery-only jobs and for jobs with a short follow-on (a few days of installation and " +
      "commissioning) — either way the balance is confirmed through the same finance/operations " +
      "exchange, not billed automatically the instant a delivery closes.",
    netDays: 15,
    milestones: [
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance on delivery", pct: "50", trigger: "manual" },
    ],
  },
  {
    name: "50% Downpayment, 50% Upon Completion",
    description:
      "Half on order to let the job proceed, the other half released once operations confirms the " +
      "whole job — supply, delivery and whatever follows it — is actually done.",
    netDays: 15,
    milestones: [
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance on completion", pct: "50", trigger: "manual" },
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
    manual: "on invoice",
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

  // The retired five: switched off, never deleted — a quotation that already agreed to one of them
  // is a real contract, and `isActive: false` is what already keeps it out of new selection without
  // touching what it points at (the same rule #130's stray fixtures are kept out by).
  const retired = await db.paymentTerm.updateMany({
    where: { name: { in: RETIRED_TERM_NAMES }, isActive: true },
    data: { isActive: false },
  });

  console.log(`Payment terms: ${created} created, ${updated} updated, ${retired.count} retired.`);
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
