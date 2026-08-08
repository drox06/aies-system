/**
 * Pure accreditation rules — no database, no Prisma.
 *
 * Split out of accreditation-service.ts so client components can use them without dragging Prisma
 * into the browser bundle. Same reasoning as the router/service split.
 *
 * specs/01-crm-inquiry.md §5b, narrowed by the company: the documents AIES submits to *get*
 * accredited (SEC registration, BIR 2303, mayor's permit, PCAB licence…) are submitted and tracked
 * on each customer's own portal, which is the authoritative record of them. This system tracks the
 * *outcome* only — the certificate the customer issued back, and when it expires. See
 * docs/DECISIONS.md #19 for why the per-document checklist §5b describes was dropped rather than
 * mirrored.
 */

export const ACCREDITATION_STATUSES = [
  "not_started",
  "preparing",
  "submitted",
  "under_review",
  "accredited",
  "rejected",
  "expired",
  "renewal_due",
] as const;

export type AccreditationStatus = (typeof ACCREDITATION_STATUSES)[number];

/** The entityType accreditation certificates are stored under, so the upload endpoint and the
 *  file-access checker agree on one string. */
export const ACCREDITATION_ENTITY_TYPE = "AccreditationRecord";

/** §5b's reminder ladder, and the window in which the badge reads "renewal due". */
export const RENEWAL_WARNING_DAYS = 90;

const DAY_MS = 86_400_000;

export interface AccreditationHealth {
  /** The record's status after applying what the expiry date actually says. */
  effectiveStatus: AccreditationStatus;
  /** True when this customer cannot currently issue AIES a PO. */
  blocksSelling: boolean;
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
}

/**
 * Derives what an accreditation record means right now.
 *
 * Stored status alone is not trustworthy: a record can say `accredited` while its expiry date
 * passed last week, and nobody runs a job before opening a page. So the date wins, and the UI shows
 * the derived answer.
 */
export function assessAccreditation(
  record: { status: string; expiresAt: Date | null },
  now: Date = new Date(),
): AccreditationHealth {
  const daysUntilExpiry =
    record.expiresAt === null
      ? null
      : Math.floor((record.expiresAt.getTime() - now.getTime()) / DAY_MS);

  let effectiveStatus = record.status as AccreditationStatus;

  if (record.status === "accredited" && daysUntilExpiry !== null) {
    if (daysUntilExpiry < 0) {
      effectiveStatus = "expired";
    } else if (daysUntilExpiry <= RENEWAL_WARNING_DAYS) {
      effectiveStatus = "renewal_due";
    }
  }

  // §5b: "Quoting a customer who cannot issue you a PO is wasted effort." Every state that is not a
  // live accreditation blocks, including the in-progress ones — being halfway through submission is
  // still not being accredited. `renewal_due` does not block: it is still valid, just expiring.
  const blocksSelling = effectiveStatus !== "accredited" && effectiveStatus !== "renewal_due";

  return {
    effectiveStatus,
    blocksSelling,
    expiresAt: record.expiresAt,
    daysUntilExpiry,
  };
}

export interface AccreditedGateResult {
  ok: boolean;
  /** Why not, phrased for the person trying to do it. */
  reasons: string[];
}

/**
 * Whether a record may be marked `accredited`.
 *
 * Being accredited is a claim with consequences — it tells a salesperson this customer can issue a
 * PO. With the document checklist gone, these two fields are the *entire* evidence base, so the
 * gate matters more than it did, not less.
 *
 * The expiry is required because an accreditation with no expiry never becomes `renewal_due`, so
 * it is never chased — which is the failure §5b exists to fix.
 */
export function assertCanBeAccredited(record: {
  certificateFileId?: string | null;
  expiresAt?: Date | string | null;
}): AccreditedGateResult {
  const reasons: string[] = [];
  if (!record.certificateFileId) {
    reasons.push("Upload the accreditation certificate issued by the customer.");
  }
  if (!record.expiresAt) {
    reasons.push("Enter the expiry date shown on the certificate.");
  }
  return { ok: reasons.length === 0, reasons };
}
