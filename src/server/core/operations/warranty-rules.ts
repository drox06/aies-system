/**
 * Warranty rules (specs/04-operations-projects.md §11).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §11: "The flowchart's warranty diamond after T&C loops back to Project Execution. This models the
 * **warranty callback**: work already commissioned comes back for rectification."
 *
 * So this is not a gate that holds a job up on its way out. It is the door work comes back through,
 * which is why the decision it makes is commercial rather than procedural: who pays.
 */

export const WARRANTY_ENTITY_TYPE = "WarrantyClaim";
export const WARRANTY_DOCUMENT_TYPE = "warranty_claim";

/**
 * Whether the equipment was inside its warranty window when the fault was reported.
 *
 * `unknown` is a real answer and not a missing one. Equipment reaches the installed base from
 * commissioning, from a migration, or from somebody typing it in, and plenty of it will have no
 * recorded window. Defaulting that to `out_of_warranty` bills a customer for something possibly
 * covered; defaulting it to `in_warranty` gives work away. Both are the software deciding a
 * commercial question it cannot answer — so it says so and asks. docs/DECISIONS.md #71.
 */
export const COVERAGE = ["in_warranty", "out_of_warranty", "unknown"] as const;
export type Coverage = (typeof COVERAGE)[number];

export const COVERAGE_LABELS: Record<Coverage, string> = {
  in_warranty: "In warranty",
  out_of_warranty: "Out of warranty",
  unknown: "No warranty window recorded",
};

/**
 * Whose fault it was.
 *
 * §11 lists three outcomes — in warranty, out of warranty, AIES-caused — but the third is not a
 * third value of the same field. It is a **separate question**, and the case that proves it is the
 * one a single enum would lose: *our fault, out of warranty*. §11 says an AIES-caused defect makes
 * the ticket non-billable and raises an NCR, and nothing in that sentence depends on the warranty
 * still running. A company that installed something badly does not get to charge for fixing it
 * because thirteen months have passed.
 *
 * Same shape as §8's standby attribution, for the same reason: the claim rests on who caused it.
 */
export const ATTRIBUTION = [
  "aies_caused",
  "customer_caused",
  "third_party",
  "undetermined",
] as const;
export type Attribution = (typeof ATTRIBUTION)[number];

export const ATTRIBUTION_LABELS: Record<Attribution, string> = {
  aies_caused: "AIES caused it",
  customer_caused: "The customer caused it",
  third_party: "A third party caused it",
  undetermined: "Not yet established",
};

/** §11 wants root cause reported by product and by technician, so the causes are a closed list. */
export const ROOT_CAUSE_CATEGORIES = [
  "installation_workmanship",
  "component_failure",
  "design_or_selection",
  "misapplication",
  "operator_error",
  "environmental",
  "maintenance_omitted",
  "unknown",
] as const;
export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

export const ROOT_CAUSE_LABELS: Record<RootCauseCategory, string> = {
  installation_workmanship: "Installation workmanship",
  component_failure: "Component failure",
  design_or_selection: "Design or selection",
  misapplication: "Misapplied — wrong duty",
  operator_error: "Operator error",
  environmental: "Environmental",
  maintenance_omitted: "Maintenance not carried out",
  unknown: "Not established",
};

// ---- the warranty window ------------------------------------------------------------------------

export interface WarrantyWindow {
  warrantyStart?: Date | string | null;
  warrantyEnd?: Date | string | null;
}

const asTime = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export interface CoverageReading {
  coverage: Coverage;
  /** Said in words, because this decides who pays and somebody will be asked to justify it. */
  reason: string;
  /** Days remaining on the window, or past it. Null when there is no window to count against. */
  daysRemaining: number | null;
}

/**
 * Reads the window. It does not decide the claim — a person does, and may disagree.
 *
 * The end date is inclusive: warranty to the 31st means the 31st is covered. Treating it as
 * exclusive would deny a claim on its last day, which is the day claims actually arrive.
 */
export function readCoverage(
  equipment: WarrantyWindow | null | undefined,
  onDate: Date = new Date(),
): CoverageReading {
  if (!equipment) {
    return {
      coverage: "unknown",
      reason: "No equipment record, so there is no window to read.",
      daysRemaining: null,
    };
  }

  const end = asTime(equipment.warrantyEnd);
  const start = asTime(equipment.warrantyStart);
  const at = onDate.getTime();

  if (end === null) {
    return {
      coverage: "unknown",
      reason:
        "No warranty end date recorded. This is not the same as expired — somebody has to establish " +
        "the terms before this claim can be answered.",
      daysRemaining: null,
    };
  }

  // Inclusive of the whole end day.
  const endOfDay = end + 24 * 60 * 60 * 1000 - 1;
  const days = Math.ceil((endOfDay - at) / (24 * 60 * 60 * 1000));

  if (start !== null && at < start) {
    return {
      coverage: "unknown",
      reason: "The fault was reported before the warranty was due to start. Check the dates.",
      daysRemaining: days,
    };
  }

  if (at <= endOfDay) {
    return {
      coverage: "in_warranty",
      reason: `Covered — ${days} day(s) left on the window.`,
      daysRemaining: days,
    };
  }

  return {
    coverage: "out_of_warranty",
    reason: `The window closed ${Math.abs(days)} day(s) ago.`,
    daysRemaining: days,
  };
}

// ---- §11's determination ------------------------------------------------------------------------

export interface Determination {
  billable: boolean;
  /** §11: an AIES-caused defect "auto-raises an NCR (module 08)". */
  ncrRequired: boolean;
  /** §11: out of warranty "prompts sales to quote the rectification, because it is chargeable work". */
  referToSales: boolean;
  /** Whether this raises the non-billable after_sales ticket §11 describes. */
  raisesTicket: boolean;
  route: "warranty_ticket" | "sales_quote" | "needs_determination";
  reason: string;
}

/**
 * What §11 does with a claim, given the two answers.
 *
 * The table, in the order the rules bite:
 *
 *  - **AIES caused it** → non-billable and an NCR, whatever the window says. The case a single enum
 *    would have lost.
 *  - **In warranty** → non-billable, raises the warranty ticket.
 *  - **Out of warranty, not ours** → chargeable, so it goes to sales to quote rather than becoming
 *    free work by default.
 *  - **Unknown window, or undetermined cause** → neither. Somebody establishes it first, because
 *    every other route commits the company to a position on who pays.
 */
export function determine(input: { coverage: Coverage; attribution: Attribution }): Determination {
  if (input.attribution === "aies_caused") {
    return {
      billable: false,
      ncrRequired: true,
      referToSales: false,
      raisesTicket: true,
      route: "warranty_ticket",
      reason:
        input.coverage === "out_of_warranty"
          ? "AIES caused this. Out of warranty, and still not chargeable — the window does not " +
            "excuse the company's own defect. §11 also makes it a quality event, so it raises an NCR."
          : "AIES caused this: non-billable, and an NCR because a defect the company caused is a " +
            "quality event and not just a job.",
    };
  }

  if (input.coverage === "unknown") {
    return {
      billable: false,
      ncrRequired: false,
      referToSales: false,
      raisesTicket: false,
      route: "needs_determination",
      reason:
        "No warranty window is recorded, so nobody can say whether this is covered. Establish the " +
        "terms before answering the customer — guessing commits the company either way.",
    };
  }

  if (input.coverage === "in_warranty") {
    return {
      billable: false,
      ncrRequired: false,
      referToSales: false,
      raisesTicket: true,
      route: "warranty_ticket",
      reason:
        "In warranty: a non-billable after-sales ticket, back into execution as the flowchart draws it.",
    };
  }

  if (input.attribution === "undetermined") {
    return {
      billable: false,
      ncrRequired: false,
      referToSales: false,
      raisesTicket: false,
      route: "needs_determination",
      reason:
        "Out of warranty, but nobody has established the cause. If it turns out to be ours it is " +
        "not chargeable, so quoting for it now would be the wrong answer given to the customer first.",
    };
  }

  return {
    billable: true,
    ncrRequired: false,
    referToSales: true,
    raisesTicket: false,
    route: "sales_quote",
    reason:
      "Out of warranty and not AIES's fault, so it is chargeable work. Sales quotes the " +
      "rectification rather than the crew doing it for nothing.",
  };
}

// ---- what a claim needs before it can be answered ------------------------------------------------

export interface ClaimCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function checkClaim(input: {
  faultDescription: string;
  coverage: Coverage;
  attribution: Attribution;
  rootCauseCategory?: string | null;
  coverageOverrideReason?: string | null;
  /** What the dates said, when there is equipment to read them from. */
  readingCoverage?: Coverage | null;
}): ClaimCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.faultDescription?.trim()) {
    errors.push(
      "A claim needs the fault described. 'It broke' is not something anybody can act on.",
    );
  }

  if (!COVERAGE.includes(input.coverage)) {
    errors.push(`"${input.coverage}" is not a coverage answer.`);
  }
  if (!ATTRIBUTION.includes(input.attribution)) {
    errors.push(`"${input.attribution}" is not an attribution.`);
  }

  /**
   * A person may overrule the dates — a goodwill repair, or terms the record never captured. What
   * they may not do is overrule them silently, because the next person to read this needs to know
   * the answer did not come from the window.
   */
  if (
    input.readingCoverage &&
    input.readingCoverage !== input.coverage &&
    !input.coverageOverrideReason?.trim()
  ) {
    errors.push(
      `The record says ${COVERAGE_LABELS[input.readingCoverage].toLowerCase()} and this claim says ` +
        `${COVERAGE_LABELS[input.coverage].toLowerCase()}. Say why — an override nobody explains is ` +
        "indistinguishable from a mistake.",
    );
  }

  if (input.attribution === "aies_caused" && !input.rootCauseCategory) {
    errors.push(
      "An AIES-caused defect needs a root cause category. §11 reports warranty cost by cause, and " +
        "'ours' with no cause tells nobody what to stop doing.",
    );
  }

  if (
    input.rootCauseCategory &&
    !ROOT_CAUSE_CATEGORIES.includes(input.rootCauseCategory as RootCauseCategory)
  ) {
    errors.push(`"${input.rootCauseCategory}" is not a root cause category.`);
  }

  if (input.coverage === "unknown") {
    warnings.push(
      "No warranty window on this equipment. Recording the terms now saves the next claim the same " +
        "argument.",
    );
  }

  if (input.attribution === "undetermined" && input.coverage === "out_of_warranty") {
    warnings.push(
      "Out of warranty with the cause unestablished. Nothing is decided until somebody looks.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---- §11's reporting ----------------------------------------------------------------------------

export interface WarrantyRecord {
  attribution: Attribution;
  coverage: Coverage;
  rootCauseCategory?: string | null;
  billable: boolean;
  modelNumber?: string | null;
  installedByTicketId?: string | null;
  cost?: number | null;
}

/**
 * §11: "Warranty tickets are reported separately: count, cost, and root cause by product and by
 * technician. **Warranty cost that nobody totals is warranty cost that never gets fixed.**"
 *
 * The AIES-caused subtotal is the number that matters: it is the part the company could have
 * avoided, and it is the one that disappears if warranty work is only ever counted in total.
 */
export function warrantySummary(records: readonly WarrantyRecord[]) {
  const byCause = new Map<string, { count: number; cost: number }>();
  const byProduct = new Map<string, { count: number; cost: number }>();

  let aiesCausedCount = 0;
  let aiesCausedCost = 0;
  let totalCost = 0;

  for (const record of records) {
    const cost = record.cost ?? 0;
    totalCost += cost;

    if (record.attribution === "aies_caused") {
      aiesCausedCount += 1;
      aiesCausedCost += cost;
    }

    const cause = record.rootCauseCategory ?? "unknown";
    const causeEntry = byCause.get(cause) ?? { count: 0, cost: 0 };
    byCause.set(cause, { count: causeEntry.count + 1, cost: causeEntry.cost + cost });

    const product = record.modelNumber ?? "unspecified";
    const productEntry = byProduct.get(product) ?? { count: 0, cost: 0 };
    byProduct.set(product, { count: productEntry.count + 1, cost: productEntry.cost + cost });
  }

  return {
    total: records.length,
    totalCost,
    aiesCausedCount,
    aiesCausedCost,
    /** Of the warranty work done, how much of it the company caused. Null over no claims. */
    aiesCausedPct:
      records.length === 0 ? null : Math.round((aiesCausedCount / records.length) * 1000) / 10,
    byCause: [...byCause.entries()]
      .map(([category, entry]) => ({ category, ...entry }))
      .sort((a, b) => b.count - a.count),
    byProduct: [...byProduct.entries()]
      .map(([modelNumber, entry]) => ({ modelNumber, ...entry }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * §16's renewal loop, the part §11 needs: warranties about to expire.
 *
 * Reported as a lead rather than a warning — §16 calls this "where the recurring revenue in this
 * business lives", and a warranty ending is the moment to offer a maintenance contract.
 */
export function expiringWithin(
  equipment: readonly (WarrantyWindow & { id: string })[],
  days: number,
  onDate: Date = new Date(),
): { id: string; daysRemaining: number }[] {
  return equipment
    .map((item) => ({ id: item.id, reading: readCoverage(item, onDate) }))
    .filter(
      (entry) =>
        entry.reading.coverage === "in_warranty" &&
        entry.reading.daysRemaining !== null &&
        entry.reading.daysRemaining <= days,
    )
    .map((entry) => ({ id: entry.id, daysRemaining: entry.reading.daysRemaining! }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}
