import { db } from "@/lib/db";
import { assessAccreditation } from "@/server/core/crm/accreditation-service";

/**
 * The derived "does this account need attention?" signal shown on the accounts list and on any
 * inquiry raised against the account.
 *
 * §5b asks for one specific case of this — "Accreditation status shows on the account and on the
 * inquiry. Quoting a customer who cannot issue you a PO is wasted effort, and the salesperson
 * should see that before writing the quote, not after." But the same badge needs to carry finance
 * signals too (unbilled work, overdue collections), and those live in module 05, which does not
 * exist.
 *
 * So this is a registry of *contributors* rather than a hardcoded query. Accreditation registers
 * one now; module 05 registers a finance one later by calling `registerAccountFlagContributor` and
 * changing nothing here or in the UI. The alternative — a query that joins accreditation today and
 * gets rewritten to join invoices tomorrow — is how a list page ends up owning half the domain.
 *
 * Every contributor is **batched**: it receives all the account ids on the page at once. A
 * per-account contributor would turn a 25-row table into 25 sequential round-trips, and at the
 * ~183ms this database sits away that is a five-second page.
 */

export type FlagSeverity =
  /** Cannot trade with this customer right now. */
  | "blocking"
  /** Will become blocking if ignored — a renewal window, an ageing receivable. */
  | "warning"
  /** Worth knowing, needs no action. */
  | "info";

export interface AccountFlag {
  /** Stable identifier for the contributor, e.g. "accreditation". */
  kind: string;
  severity: FlagSeverity;
  /** Short enough for a table cell. */
  label: string;
  /** The detail behind it, for a tooltip or the account page. */
  detail?: string;
}

export type AccountFlagContributor = (
  accountIds: string[],
) => Promise<Map<string, AccountFlag[]>> | Map<string, AccountFlag[]>;

const contributors = new Map<string, AccountFlagContributor>();

export function registerAccountFlagContributor(kind: string, fn: AccountFlagContributor): void {
  contributors.set(kind, fn);
}

/** Test-only. */
export function __resetAccountFlagContributorsForTests(): void {
  contributors.clear();
}

/**
 * Flags for many accounts at once.
 *
 * A contributor that throws is skipped rather than allowed to fail the whole list: a broken
 * finance integration should not take the CRM down, and a missing badge is a far smaller problem
 * than an unusable accounts page.
 */
export async function getAccountFlags(accountIds: string[]): Promise<Map<string, AccountFlag[]>> {
  const out = new Map<string, AccountFlag[]>();
  if (accountIds.length === 0) return out;

  const results = await Promise.all(
    [...contributors.entries()].map(async ([kind, fn]) => {
      try {
        return await fn(accountIds);
      } catch (error) {
        console.error(`[account-health] contributor "${kind}" failed:`, error);
        return new Map<string, AccountFlag[]>();
      }
    }),
  );

  for (const result of results) {
    for (const [accountId, flags] of result) {
      const existing = out.get(accountId);
      if (existing) existing.push(...flags);
      else out.set(accountId, [...flags]);
    }
  }

  // Worst first, so a table cell showing only the first flag shows the one that matters.
  const rank: Record<FlagSeverity, number> = { blocking: 0, warning: 1, info: 2 };
  for (const flags of out.values()) {
    flags.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
  return out;
}

/** The single worst severity across an account's flags, for a badge that shows one thing. */
export function worstSeverity(flags: AccountFlag[] | undefined): FlagSeverity | null {
  if (!flags || flags.length === 0) return null;
  if (flags.some((f) => f.severity === "blocking")) return "blocking";
  if (flags.some((f) => f.severity === "warning")) return "warning";
  return "info";
}

// ---- accreditation contributor (specs/01-crm-inquiry.md §5b) ----------------------------------

const STATUS_LABEL: Record<string, string> = {
  not_started: "Accreditation not started",
  preparing: "Accreditation in preparation",
  submitted: "Accreditation submitted",
  under_review: "Accreditation under review",
  accredited: "Accredited",
  rejected: "Accreditation rejected",
  expired: "Accreditation expired",
  renewal_due: "Accreditation renewal due",
};

registerAccountFlagContributor("accreditation", async (accountIds) => {
  const records = await db.accreditationRecord.findMany({
    where: { accountId: { in: accountIds }, deletedAt: null },
    select: { accountId: true, status: true, expiresAt: true, requirements: true },
  });

  const out = new Map<string, AccountFlag[]>();

  // An account with no accreditation record at all is flagged too. Silence would read as "fine",
  // and for an industrial customer the absence of an accreditation is exactly the problem.
  const withRecord = new Set(records.map((r) => r.accountId));
  for (const accountId of accountIds) {
    if (!withRecord.has(accountId)) {
      out.set(accountId, [
        {
          kind: "accreditation",
          severity: "info",
          label: "Not accredited",
          detail:
            "No accreditation record. Most industrial and utility customers will not issue a PO without one.",
        },
      ]);
    }
  }

  for (const record of records) {
    const health = assessAccreditation(record);
    const flags: AccountFlag[] = [];

    if (health.blocksSelling) {
      flags.push({
        kind: "accreditation",
        severity:
          health.effectiveStatus === "expired" || health.effectiveStatus === "rejected"
            ? "blocking"
            : "info",
        label: STATUS_LABEL[health.effectiveStatus] ?? health.effectiveStatus,
        detail:
          health.effectiveStatus === "expired"
            ? "This customer cannot issue a PO until the accreditation is renewed."
            : health.missingDocuments.length > 0
              ? `Outstanding: ${health.missingDocuments.slice(0, 3).join(", ")}${health.missingDocuments.length > 3 ? "…" : ""}`
              : undefined,
      });
    } else if (health.effectiveStatus === "renewal_due") {
      const soonest = health.expiringDocuments[0];
      flags.push({
        kind: "accreditation",
        severity: "warning",
        label: "Accreditation renewal due",
        detail: soonest
          ? `${soonest.document} ${soonest.daysRemaining < 0 ? "expired" : `expires in ${soonest.daysRemaining} day(s)`}`
          : health.daysUntilExpiry !== null
            ? `Expires in ${health.daysUntilExpiry} day(s)`
            : undefined,
      });
    }

    if (flags.length > 0) out.set(record.accountId, flags);
  }

  return out;
});
