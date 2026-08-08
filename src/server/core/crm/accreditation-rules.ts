import { z } from "zod";

/**
 * Pure accreditation rules — no database, no Prisma.
 *
 * Split out of accreditation-service.ts because the checklist UI needs `parseRequirements` to
 * validate a `Json` column client-side, and importing the service would drag Prisma into the
 * browser bundle. Same reasoning as the router/service split: the logic worth testing and sharing
 * should not be welded to the thing that needs a connection.
 *
 * specs/01-crm-inquiry.md §5b.
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

/**
 * One checklist row. §5b's shape verbatim, with the JSON validated here because Prisma treats a
 * `Json` column as `unknown` — without this, a typo in a requirement key would be written happily
 * and only surface as a blank row in the UI months later.
 */
export const accreditationRequirementSchema = z.object({
  document: z.string().min(1),
  required: z.boolean().default(true),
  /** FileObject id from module 00's storage service. §5b says documents come from the DMS
   *  (module 07); until that exists, a direct upload through /api/files fills the same slot. */
  providedFileId: z.string().nullish(),
  submittedAt: z.string().nullish(),
  acceptedAt: z.string().nullish(),
  /** §5b: "a mayor's permit expires annually and quietly invalidates an accreditation. Track
   *  expiry **per document**, not just per accreditation." This field is the whole point. */
  expiresAt: z.string().nullish(),
  notes: z.string().nullish(),
});

export type AccreditationRequirement = z.infer<typeof accreditationRequirementSchema>;

export const accreditationRequirementsSchema = z.array(accreditationRequirementSchema);

/**
 * §5b's seed template. Every customer asks for a slightly different set, so this is a starting
 * checklist PD edits per account, not a fixed schema.
 *
 * `required` marks what a Philippine industrial or utility buyer asks for as a matter of course;
 * the rest are common but conditional (PCAB matters for contracting work, PhilGEPS for government
 * bidding, audited financials above certain contract values).
 */
export const DEFAULT_ACCREDITATION_REQUIREMENTS: readonly {
  document: string;
  required: boolean;
}[] = [
  { document: "SEC registration", required: true },
  { document: "BIR Form 2303 (Certificate of Registration)", required: true },
  { document: "Mayor's / Business permit (current year)", required: true },
  { document: "Company profile", required: true },
  { document: "List of clients / reference list", required: true },
  { document: "Audited financial statements", required: false },
  { document: "DTI registration", required: false },
  { document: "PhilGEPS registration", required: false },
  { document: "PCAB licence", required: false },
  { document: "ISO certificates", required: false },
  { document: "Safety programme (DOLE)", required: false },
  { document: "Sample test / calibration certificates", required: false },
];

export function defaultRequirements(): AccreditationRequirement[] {
  return DEFAULT_ACCREDITATION_REQUIREMENTS.map((r) => ({
    document: r.document,
    required: r.required,
    providedFileId: null,
    submittedAt: null,
    acceptedAt: null,
    expiresAt: null,
    notes: null,
  }));
}

export function parseRequirements(value: unknown): AccreditationRequirement[] {
  const parsed = accreditationRequirementsSchema.safeParse(value);
  // A malformed array is a bug, not user input, and throwing here would take out the whole
  // accounts list. Returning empty degrades one panel instead.
  return parsed.success ? parsed.data : [];
}

/** §5b: renewal reminders at 90/60/30 days. The largest is also the window the account badge uses
 *  to say "renewal due", so the salesperson sees it before writing the quote, not after. */
export const RENEWAL_WARNING_DAYS = 90;

export interface AccreditationHealth {
  /** The record's own status, after applying what the document expiries actually say. */
  effectiveStatus: AccreditationStatus;
  /** True when this customer cannot currently issue AIES a PO. */
  blocksSelling: boolean;
  /** Requirements that are required, expired or expiring within the warning window. */
  expiringDocuments: { document: string; expiresAt: string; daysRemaining: number }[];
  /** Required requirements with nothing provided yet. */
  missingDocuments: string[];
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Derives what an accreditation record actually means right now.
 *
 * Pure, and separate from the database, because §5b's real rule is subtle: a record can say
 * `accredited` while a mayor's permit inside it expired last week, which in practice means the
 * accreditation is void. Stored status alone is therefore not trustworthy, and the UI must show the
 * derived answer. This is the function the account badge and the renewal sweep both read.
 */
export function assessAccreditation(
  record: {
    status: string;
    expiresAt: Date | null;
    requirements: unknown;
  },
  now: Date = new Date(),
): AccreditationHealth {
  const requirements = parseRequirements(record.requirements);

  const expiringDocuments: AccreditationHealth["expiringDocuments"] = [];
  const missingDocuments: string[] = [];
  let anyRequiredDocExpired = false;

  for (const req of requirements) {
    if (req.required && !req.providedFileId && !req.submittedAt) {
      missingDocuments.push(req.document);
    }
    if (!req.expiresAt) continue;
    const expiry = new Date(req.expiresAt);
    if (Number.isNaN(expiry.getTime())) continue;
    const daysRemaining = Math.floor((expiry.getTime() - now.getTime()) / DAY_MS);
    if (daysRemaining <= RENEWAL_WARNING_DAYS) {
      expiringDocuments.push({ document: req.document, expiresAt: req.expiresAt, daysRemaining });
      if (daysRemaining < 0 && req.required) anyRequiredDocExpired = true;
    }
  }
  expiringDocuments.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const daysUntilExpiry =
    record.expiresAt === null
      ? null
      : Math.floor((record.expiresAt.getTime() - now.getTime()) / DAY_MS);

  let effectiveStatus = record.status as AccreditationStatus;

  // The overall expiry date having passed beats a stale stored status. Nobody remembers to run a
  // job before opening the page.
  if (record.status === "accredited") {
    if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
      effectiveStatus = "expired";
    } else if (anyRequiredDocExpired) {
      // §5b's exact scenario: "a mayor's permit expires annually and quietly invalidates an
      // accreditation."
      effectiveStatus = "expired";
    } else if (daysUntilExpiry !== null && daysUntilExpiry <= RENEWAL_WARNING_DAYS) {
      effectiveStatus = "renewal_due";
    } else if (expiringDocuments.length > 0) {
      effectiveStatus = "renewal_due";
    }
  }

  // §5b: "Quoting a customer who cannot issue you a PO is wasted effort." Anything that is not a
  // live accreditation blocks, including in-progress states — being halfway through submission is
  // still not being accredited.
  const blocksSelling = effectiveStatus !== "accredited" && effectiveStatus !== "renewal_due";

  return {
    effectiveStatus,
    blocksSelling,
    expiringDocuments,
    missingDocuments,
    expiresAt: record.expiresAt,
    daysUntilExpiry,
  };
}
