/**
 * Site inspection rules (specs/04-operations-projects.md §6.1).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs, same split as cash-advance-rules.ts.
 *
 * §6.1's own summary of why this section earns its weight: "Discovering at inspection that the job
 * is bigger than quoted is normal; discovering it *after* mobilization is expensive. This link is
 * one of the highest-value things the platform does."
 */

export const SITE_INSPECTION_ENTITY_TYPE = "SiteInspection";
export const SITE_INSPECTION_DOCUMENT_TYPE = "site_inspection";

/**
 * Signing an inspection off as accepted.
 *
 * `project.manage` rather than a new `inspection.approve`: §19 enumerates this module's permissions
 * and does not list one for inspections, and inventing a key the spec does not have is a worse
 * deviation than reusing one it does. Accepting the survey a project will be planned from is
 * project management, and the same people do it on the module 01 route.
 *
 * It is one of the eleven permissions the 2026-08-16 audit deleted for gating nothing
 * (docs/DECISIONS.md #52). This is the change that gives it something to gate, which is exactly the
 * rule that audit set.
 */
export const INSPECTION_APPROVE_PERMISSION = "project.manage";

/** §6.1's three states. */
export const INSPECTION_STATUSES = ["scheduled", "completed", "approved"] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

/**
 * Who may open any site inspection — not only one they attended or requested — by name: EA
 * (president), KJ (vice president), DJ (operations manager). Asked for by the company on
 * 2026-09-03, naming the three by name rather than "and anyone else who needs it": *"make it
 * downloadable and online viewing by ea, kj, dj, person who raised the site inspection, and by the
 * person that conducted the inspection."*
 *
 * Emails, not roles, for the same reason `ARCHIVE_FULL_ACCESS_EMAILS` is (`task-rules.ts`): the
 * practice-authority grant (`scripts/practice-authority.ts`) currently gives all five named users the
 * `president` role, so a role check — or `project.manage`, or `ticket.view_all` — would not actually
 * restrict this to the three people asked for; it would open every survey to PD and EM as well, which
 * is exactly what naming three people rather than a permission was meant to avoid. The two lists are
 * intentionally not merged into one shared constant: one names who may see every finished task, the
 * other who may see every finished survey, and they happen to overlap on two names today because the
 * same two people are named in both requests — not because the two questions are the same question.
 * Once practice ends this and a role check become equivalent, same as the archive's; this needs no
 * revisiting when that happens.
 */
export const SITE_INSPECTION_FULL_ACCESS_EMAILS = [
  "ea@aieselectromech.com",
  "kj@aieselectromech.com",
  "dj@aieselectromech.com",
];

export function canSeeAnySiteInspection(email: string): boolean {
  return SITE_INSPECTION_FULL_ACCESS_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * The actual per-record gate: the two people the survey is about — whoever asked for it, whoever
 * went — the three named above, plus whoever has been individually granted access via `sharedWithIds`
 * (2026-09-03's "Share report to" picker: *"the user selected will have access to this site
 * inspection report"*). Replaces a `ticket.view_all` check that, in a company where "everyone does
 * everything" (Spec.md §1.2), would have handed every survey to whoever happens to hold that one
 * broad permission for unrelated dispatch reasons.
 */
export function canOpenSiteInspection(
  inspection: {
    inspectedByIds: readonly string[];
    requestedById: string | null;
    sharedWithIds?: readonly string[];
  },
  user: { id: string; email: string },
): boolean {
  return (
    inspection.inspectedByIds.includes(user.id) ||
    inspection.requestedById === user.id ||
    (inspection.sharedWithIds?.includes(user.id) ?? false) ||
    canSeeAnySiteInspection(user.email)
  );
}

/**
 * §6.1's utilities checklist, as the five things the spec names.
 *
 * A fixed list rather than free text because the question a planner asks is always the same one —
 * "is there power on site or are we bringing a generator" — and a free-text note is not answerable
 * by a screen that has to show a green tick.
 */
export const UTILITIES = ["power", "air", "water", "crane", "scaffolding"] as const;
export type Utility = (typeof UTILITIES)[number];

export const UTILITY_LABELS: Record<Utility, string> = {
  power: "Power",
  air: "Compressed air",
  water: "Water",
  crane: "Crane or lifting",
  scaffolding: "Scaffolding",
};

export interface MeasurementRow {
  label: string;
  value: string;
  unit: string;
}

// ---- what makes an inspection worth calling complete ---------------------------------------------

export interface CompletenessCheck {
  complete: boolean;
  /** What is missing, in the words a surveyor would use. */
  missing: string[];
  /** Present but worth saying out loud — not blocking. */
  warnings: string[];
}

/**
 * Whether an inspection has enough on it to be marked complete.
 *
 * ## Why this blocks on so little
 *
 * Only three things are required: when it happened, who went, and what they found. It is tempting to
 * demand photographs and measurements too — they are the reason for the visit — but §6.1 does not
 * ask for that and a hard requirement would be wrong in practice. A refused-entry visit produces no
 * photographs and is still a real inspection whose finding is "we could not get in", which is
 * exactly the sort of thing that must be recordable.
 *
 * So the missing photographs are a **warning**, which the screen shows and the record keeps. The
 * distinction matters: a block that people cannot satisfy honestly gets satisfied dishonestly, and
 * a survey with one meaningless photograph attached to clear a gate is worse than one that admits
 * it has none.
 */
/**
 * Who attended a survey, as the company records it.
 *
 * Departments rather than named staff for AIES's own people: on a site survey what matters is that
 * sales and technical were both there, and a picker of every employee is a list somebody scrolls past
 * rather than reads. Anybody who is not AIES — the client's engineer, a principal's representative —
 * goes under `other` and is named, because "other" with nothing after it records nothing at all.
 *
 * Asked for by the company on 2026-08-17, replacing a checkbox list of internal users.
 */
export const ATTENDEE_PARTIES = ["sales", "technical", "customer_rep", "other"] as const;
export type AttendeeParty = (typeof ATTENDEE_PARTIES)[number];

export const ATTENDEE_PARTY_LABELS: Record<AttendeeParty, string> = {
  sales: "Sales",
  technical: "Technical",
  /** Added 2026-09-04 — the client's own representative was previously recorded as "Technical" with
   *  their name typed in, or as an "other" guest, neither of which reads correctly on the report. */
  customer_rep: "Customer Representative",
  other: "Others",
};

export interface Attendee {
  party: AttendeeParty;
  /** Required for `other`, optional for the two internal departments. */
  name?: string | null;
}

export function readAttendees(raw: unknown): Attendee[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Attendee =>
      !!entry && typeof entry === "object" && ATTENDEE_PARTIES.includes((entry as Attendee).party),
  );
}

/** An `other` attendee with no name is a blank field wearing a label. */
export const attendeesNeedingNames = (attendees: readonly Attendee[]): Attendee[] =>
  attendees.filter((a) => a.party === "other" && !a.name?.trim());

export function describeAttendees(attendees: readonly Attendee[]): string {
  if (attendees.length === 0) return "—";
  return attendees
    .map((a) =>
      a.party === "other"
        ? a.name?.trim() || "unnamed guest"
        : a.name?.trim()
          ? `${a.name.trim()} (${ATTENDEE_PARTY_LABELS[a.party]})`
          : ATTENDEE_PARTY_LABELS[a.party],
    )
    .join(", ");
}

export function inspectionCompleteness(inspection: {
  inspectedAt: Date | string | null;
  inspectedByIds: readonly string[];
  /** `[{ party, name }]` — the record of who was actually there. */
  attendees?: unknown;
  findings: string | null;
  /**
   * Counted from `FileObject` (entityType `SiteInspection`), not a stored id list — the same choice
   * `goods-receipt-service.ts` already makes for the same reason: "Counted from the stored files,
   * never claimed on a form." `photoFileIds` looked like the source of truth but nothing in the app
   * ever wrote to it — photos are attached through the generic `Attachments` panel — so a real,
   * photographed visit was warning "No photographs" regardless (2026-09-04).
   */
  photoCount: number;
  measurements?: unknown;
  scopeChangeIdentified: boolean;
  scopeChangeNotes: string | null;
}): CompletenessCheck {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!inspection.inspectedAt) missing.push("the date the site was actually visited");
  /**
   * Attendance is read from `attendees`, not from the assignment list. The two were the same field
   * until 2026-08-17, which meant "who was sent" and "who turned up" could never disagree — and on a
   * survey they routinely do.
   */
  const attendees = readAttendees(inspection.attendees);
  if (attendees.length === 0) missing.push("who attended");
  const unnamed = attendeesNeedingNames(attendees);
  if (unnamed.length > 0) {
    missing.push(`the name of ${unnamed.length} attendee(s) recorded as "others"`);
  }
  if (!inspection.findings?.trim()) missing.push("what was found");

  /**
   * The one hard rule beyond the three, and it is §6.1's whole point.
   *
   * A scope change flagged with no explanation is a red light with no cause. Module 02 is about to
   * tell sales the job is bigger than quoted, and "why" is the only part of that message they can
   * act on — without it, the notification is an accusation that a quotation is wrong with nothing
   * to revise it against.
   */
  if (inspection.scopeChangeIdentified && !inspection.scopeChangeNotes?.trim()) {
    missing.push("what changed about the scope — sales cannot revise a quotation against a flag");
  }

  if (inspection.photoCount === 0) {
    warnings.push(
      "No photographs. Not a blocker — a refused-entry visit is still a real inspection — but a " +
        "survey nobody photographed is one somebody will have to repeat.",
    );
  }

  if (Array.isArray(inspection.measurements) && inspection.measurements.length === 0) {
    warnings.push("No measurements recorded.");
  }

  return { complete: missing.length === 0, missing, warnings };
}

// ---- §6's branch --------------------------------------------------------------------------------

/**
 * §6: "Only `new_project` tickets take this branch, per the flowchart."
 *
 * Reported rather than enforced, and the distinction is deliberate. The sentence describes which
 * tickets *require* a survey before planning, not which tickets one is *permitted* to record.
 * Sending somebody to look at a site before an after-sales callout is ordinary good practice, and a
 * system that refused to file the report would simply mean the report lives in somebody's phone.
 *
 * So this drives the prompt on the ticket — "this is a new project, §6 wants a survey first" — and
 * nothing refuses an inspection on any other type.
 */
export function inspectionRequiredForTicket(ticket: { type: string }): boolean {
  return ticket.type === "new_project";
}

/** Whether an inspection still accepts edits. Approved is a signature; it does not get rewritten. */
export function isInspectionEditable(status: string): boolean {
  return status === "scheduled" || status === "completed";
}

/**
 * Whether `userId` may reopen an *accomplished* (`completed`) report to correct it.
 *
 * Before 2026-09-04, `completed` gave no protection at all beyond "not yet approved" —
 * `isInspectionEditable` above stayed true and anybody with `ticket.execute` could freely rewrite a
 * finished report, silently. Asked for by the company after exactly that happened: "the inputs...
 * disappeared" on a report the PDF still had correctly, because the record itself had been reopened
 * and overwritten with nobody accountable for why. So once accomplished, the record freezes; only the
 * person who actually conducted the inspection — named in `inspectedByIds`, not merely anyone with the
 * permission — may reopen it, and reopening it is a tracked revision (`saveInspectionService` requires
 * a reason once this is true), not a second silent edit.
 *
 * Stops at `completed` on purpose — `approved` stays refused entirely, exactly as `isInspectionEditable`
 * already refuses it. An approved report is the one state this codebase already calls a signature;
 * widening revision to cover it too would undo that decision rather than close the gap next to it.
 */
export function canReviseInspection(
  inspection: { status: string; inspectedByIds: readonly string[] },
  userId: string,
): boolean {
  return inspection.status === "completed" && inspection.inspectedByIds.includes(userId);
}

// ---- the scope-change link ----------------------------------------------------------------------

export interface ScopeChangeVerdict {
  /** True when this save is the one that should tell sales. */
  shouldReport: boolean;
  reason: string;
}

/**
 * Whether saving this inspection should emit `scope_change.identified`.
 *
 * Fires **once**, on the transition from not-flagged to flagged-and-explained, and never again —
 * `scopeChangeReportedAt` is the record of having told sales. Re-saving an inspection to correct a
 * measurement must not send a second "the job is bigger than quoted" notification, because a
 * warning that arrives repeatedly is one people learn to close without reading, and this is
 * precisely the warning §6.1 says must land.
 *
 * It also refuses to fire on a flag with no notes. `inspectionCompleteness` blocks that case on the
 * way to `completed`, but an inspection can be saved while still `scheduled`, and a half-filled
 * draft should not page sales.
 */
export function scopeChangeVerdict(inspection: {
  scopeChangeIdentified: boolean;
  scopeChangeNotes: string | null;
  scopeChangeReportedAt: Date | string | null;
}): ScopeChangeVerdict {
  if (!inspection.scopeChangeIdentified) {
    return { shouldReport: false, reason: "No scope change was flagged." };
  }
  if (inspection.scopeChangeReportedAt) {
    return { shouldReport: false, reason: "Sales has already been told about this one." };
  }
  if (!inspection.scopeChangeNotes?.trim()) {
    return {
      shouldReport: false,
      reason: "Flagged, but with nothing sales could act on. Say what changed.",
    };
  }
  return { shouldReport: true, reason: "" };
}

/** The five utilities, normalised out of the Json column for a screen or a PDF. */
export function readUtilities(
  raw: unknown,
): { key: Utility; label: string; available: boolean | null; note: string | null }[] {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return UTILITIES.map((key) => {
    const entry = source[key];
    if (!entry || typeof entry !== "object") {
      // Absent means nobody checked, which is different from "not available" and is shown as such.
      return { key, label: UTILITY_LABELS[key], available: null, note: null };
    }
    const record = entry as { available?: unknown; note?: unknown };
    return {
      key,
      label: UTILITY_LABELS[key],
      available: typeof record.available === "boolean" ? record.available : null,
      note: typeof record.note === "string" && record.note.trim() ? record.note : null,
    };
  });
}
