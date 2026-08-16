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
export function inspectionCompleteness(inspection: {
  inspectedAt: Date | string | null;
  inspectedByIds: readonly string[];
  findings: string | null;
  photoFileIds: readonly string[];
  measurements?: unknown;
  scopeChangeIdentified: boolean;
  scopeChangeNotes: string | null;
}): CompletenessCheck {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!inspection.inspectedAt) missing.push("the date the site was actually visited");
  if (inspection.inspectedByIds.length === 0) missing.push("who attended");
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

  if (inspection.photoFileIds.length === 0) {
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
