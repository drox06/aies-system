/**
 * specs/04-operations-projects.md §16, as pure functions.
 *
 * ## The renewal loop is the section
 *
 * §16 says it in one sentence and it is the most commercially loaded line in the spec pack:
 * "contracts expiring in 90 days, calibrations due in 60, warranties expiring, and equipment past its
 * service interval generate leads back into module 01. **This is where the recurring revenue in this
 * business lives.**"
 *
 * Every one of those four is a sale the company has already earned the right to make — the customer
 * owns the equipment, AIES installed it, and somebody has to service it. Missing them is not a
 * missed opportunity in the abstract; it is a competitor being invited in by silence.
 *
 * ## Why each due date is its own reason
 *
 * The obvious implementation is one "needs attention" flag and a date. That collapses four
 * conversations into one and makes the lead useless: "your contract ends next quarter" and "your
 * transmitter is out of calibration next month" are different calls, to different people, with
 * different urgency. So `dueRenewals` returns a typed reason per item and the caller keeps them
 * apart.
 *
 * ## Why "flagged once" matters here more than elsewhere
 *
 * A nightly sweep that re-raises the same contract every night for ninety nights teaches sales to
 * ignore the alert, and then the *ninety-first* one — a real lapse — is ignored too. Same reasoning
 * as #83's unsigned delivery receipt and #70's warning that always fires. The caller records that it
 * has raised each one; these functions just say what is due.
 */

// ---- windows -------------------------------------------------------------------------------------

/**
 * §16's four windows, in days. Constants rather than settings because `SystemSetting` belongs to
 * module 09; the seam is here for when it lands, exactly as §3's SLA and §13's escalation did.
 */
export const RENEWAL_WINDOWS = {
  /** "contracts expiring in 90 days" */
  contract: 90,
  /** "calibrations due in 60" */
  calibration: 60,
  /** "warranties expiring" — no number given, so the same 90 as a contract: both are renewal talks. */
  warranty: 90,
  /** "equipment past its service interval" — already overdue, so the window is zero. */
  service: 0,
} as const;

export const RENEWAL_REASONS = [
  "contract_expiring",
  "calibration_due",
  "warranty_expiring",
  "service_overdue",
] as const;
export type RenewalReason = (typeof RENEWAL_REASONS)[number];

export const RENEWAL_REASON_LABELS: Record<RenewalReason, string> = {
  contract_expiring: "Maintenance contract ending",
  calibration_due: "Calibration due",
  warranty_expiring: "Warranty ending",
  service_overdue: "Past its service interval",
};

/**
 * What each reason is actually worth talking to the customer about.
 *
 * Carried with the lead because the person who picks it up three weeks later has no idea why the
 * system raised it, and a lead with no argument attached gets closed as noise.
 */
export const RENEWAL_PITCH: Record<RenewalReason, string> = {
  contract_expiring:
    "The contract lapses on this date. Renewing before it does keeps the visits continuous — a gap " +
    "means the next call is a breakdown rather than a visit.",
  calibration_due:
    "An instrument past its calibration date is one whose readings nobody can defend. If this feeds " +
    "a custody transfer or a quality record, the customer needs it done before the date, not after.",
  warranty_expiring:
    "Cover ends on this date. After it, the same fault is a chargeable call — which is the argument " +
    "for a maintenance contract while the equipment is still known-good.",
  service_overdue:
    "This is past the interval it was installed under. Every month it runs unserviced is wear the " +
    "customer is buying without knowing it.",
};

// ---- days ----------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from `from` to `at`, negative when `at` is in the past.
 *
 * Both instants are floored to a date first. Without that, a contract ending "in 90 days" is inside
 * or outside the window depending on the time of day the sweep runs, and a lead appears on a
 * Wednesday and vanishes on a Thursday for no reason anybody can see.
 */
export function daysUntil(at: Date | string, from: Date = new Date()): number {
  const target = typeof at === "string" ? new Date(at) : at;
  const a = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const b = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((a - b) / DAY_MS);
}

// ---- what is due ---------------------------------------------------------------------------------

export interface ContractLike {
  id: string;
  number: string;
  accountId: string;
  endDate: Date | string;
  status: string;
  renewalFlaggedAt?: Date | string | null;
}

export interface EquipmentLike {
  id: string;
  accountId: string;
  description: string;
  tagNumber?: string | null;
  serialNumber?: string | null;
  status: string;
  warrantyEnd?: Date | string | null;
  calibrationDueAt?: Date | string | null;
  nextPMDueAt?: Date | string | null;
}

export interface RenewalLead {
  reason: RenewalReason;
  entityType: "MaintenanceContract" | "Equipment";
  entityId: string;
  accountId: string;
  /** What the lead is about, in words a salesperson can read without opening the record. */
  label: string;
  dueAt: Date;
  /** Negative when already past. */
  daysUntilDue: number;
  pitch: string;
}

/**
 * Contracts inside their last `RENEWAL_WINDOWS.contract` days.
 *
 * Already-flagged ones are excluded here rather than by the caller, so the "raise it once" rule lives
 * with the rule that decides what is due — a caller that forgot the filter would produce the nightly
 * noise this is written to avoid.
 */
export function dueContractRenewals(
  contracts: readonly ContractLike[],
  now: Date = new Date(),
): RenewalLead[] {
  return contracts.flatMap((contract) => {
    if (contract.status !== "active") return [];
    if (contract.renewalFlaggedAt) return [];

    const days = daysUntil(contract.endDate, now);
    if (days > RENEWAL_WINDOWS.contract) return [];

    return [
      {
        reason: "contract_expiring" as const,
        entityType: "MaintenanceContract" as const,
        entityId: contract.id,
        accountId: contract.accountId,
        label: `${contract.number} ends ${days < 0 ? `${-days} days ago` : `in ${days} days`}`,
        dueAt: new Date(contract.endDate),
        daysUntilDue: days,
        pitch: RENEWAL_PITCH.contract_expiring,
      },
    ];
  });
}

/**
 * Equipment due for something.
 *
 * One item can raise more than one reason — a transmitter whose warranty ends the same month its
 * calibration falls due is two conversations, and merging them would drop one. The caller decides
 * whether to send them together.
 */
export function dueEquipmentRenewals(
  equipment: readonly EquipmentLike[],
  now: Date = new Date(),
): RenewalLead[] {
  const leads: RenewalLead[] = [];

  const name = (item: EquipmentLike) =>
    item.tagNumber ?? item.serialNumber ?? item.description.slice(0, 60);

  for (const item of equipment) {
    if (item.status !== "active") continue;

    // Null is not "not due" — it is "nobody recorded a date", which the platform refuses to read as
    // either answer. docs/DECISIONS.md #71 made the same call about warranty coverage.
    if (item.calibrationDueAt) {
      const days = daysUntil(item.calibrationDueAt, now);
      if (days <= RENEWAL_WINDOWS.calibration) {
        leads.push({
          reason: "calibration_due",
          entityType: "Equipment",
          entityId: item.id,
          accountId: item.accountId,
          label: `${name(item)} — calibration ${days < 0 ? `${-days} days overdue` : `due in ${days} days`}`,
          dueAt: new Date(item.calibrationDueAt),
          daysUntilDue: days,
          pitch: RENEWAL_PITCH.calibration_due,
        });
      }
    }

    if (item.warrantyEnd) {
      const days = daysUntil(item.warrantyEnd, now);
      if (days <= RENEWAL_WINDOWS.warranty && days >= 0) {
        leads.push({
          reason: "warranty_expiring",
          entityType: "Equipment",
          entityId: item.id,
          accountId: item.accountId,
          label: `${name(item)} — warranty ends in ${days} days`,
          dueAt: new Date(item.warrantyEnd),
          daysUntilDue: days,
          pitch: RENEWAL_PITCH.warranty_expiring,
        });
      }
    }

    if (item.nextPMDueAt) {
      const days = daysUntil(item.nextPMDueAt, now);
      if (days < RENEWAL_WINDOWS.service) {
        leads.push({
          reason: "service_overdue",
          entityType: "Equipment",
          entityId: item.id,
          accountId: item.accountId,
          label: `${name(item)} — ${-days} days past its service date`,
          dueAt: new Date(item.nextPMDueAt),
          daysUntilDue: days,
          pitch: RENEWAL_PITCH.service_overdue,
        });
      }
    }
  }

  return leads;
}

/** Most urgent first, so a list is useful without being sorted again by every caller. */
export function sortLeads(leads: readonly RenewalLead[]): RenewalLead[] {
  return [...leads].sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

// ---- PM visits ------------------------------------------------------------------------------------

/** §16: "PM contracts auto-generate `after_sales` tickets N days ahead of schedule." */
export const PM_TICKET_LEAD_DAYS = 14;

/**
 * When the visits a contract owes should fall.
 *
 * Evenly spaced across the term, first visit one interval in rather than on the start date — a
 * contract signed today does not owe a preventive visit today, and scheduling one teaches everybody
 * that the dates are arbitrary.
 *
 * `scheduleRule` is reserved for §17's real constraints (plant shutdowns, "every second Tuesday").
 * Until that exists, even spacing is the honest default rather than a guess dressed as a rule.
 */
export function plannedVisitDates(contract: {
  startDate: Date | string;
  endDate: Date | string;
  visitsPerYear: number;
}): Date[] {
  const start = new Date(contract.startDate);
  const end = new Date(contract.endDate);
  if (!(end > start)) return [];

  const termDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const perYear = Math.max(1, Math.floor(contract.visitsPerYear));
  const total = Math.max(1, Math.round((termDays / 365) * perYear));
  const gap = termDays / total;

  return Array.from({ length: total }, (_, index) => {
    const at = new Date(start.getTime() + gap * (index + 1) * DAY_MS);
    // The last visit lands exactly on the end date rather than a day past it through rounding.
    return at > end ? end : at;
  });
}

/** Which planned visits are close enough to raise a ticket for, and have not been raised yet. */
export function visitsToRaise(
  planned: readonly Date[],
  alreadyRaised: readonly (Date | string)[],
  now: Date = new Date(),
): Date[] {
  const raised = new Set(alreadyRaised.map((at) => daysUntil(at, now)));
  return planned.filter((at) => {
    const days = daysUntil(at, now);
    if (days > PM_TICKET_LEAD_DAYS) return false;
    return !raised.has(days);
  });
}
