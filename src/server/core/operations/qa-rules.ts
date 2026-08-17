/**
 * QA rules (specs/04-operations-projects.md §9).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §9's opening sentence decides the shape of everything here: "**Confirmed: QA is performed and
 * approved by the client, not by AIES.**" Nothing in this file expresses an opinion about whether
 * the work is good. It governs how somebody else's verdict is recorded, and what makes the record
 * worth having.
 */

export const QA_ENTITY_TYPE = "QAApproval";
export const QA_DOCUMENT_TYPE = "qa_approval";

/** §19: "record the client's QA outcome and upload evidence — operations manager and above". */
export const QA_RECORD_PERMISSION = "qa.record";

/** §9's evidence types. */
export const EVIDENCE_TYPES = [
  "client_signed_form",
  "email_confirmation",
  "inspection_report",
  "punch_sheet",
  "other",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  client_signed_form: "Client signed form",
  email_confirmation: "Email confirmation",
  inspection_report: "Inspection report",
  punch_sheet: "Punch sheet",
  other: "Other — described in the remarks",
};

/** §9's defect severities. Major and critical are the ones module 08 will raise an NCR for. */
export const DEFECT_SEVERITIES = ["minor", "major", "critical"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const DEFECT_SEVERITY_LABELS: Record<DefectSeverity, string> = {
  minor: "Minor",
  major: "Major",
  critical: "Critical",
};

export interface Defect {
  description: string;
  severity: DefectSeverity;
  ownerId?: string | null;
  dueAt?: string | null;
  status?: string;
  photoFileIds?: string[];
}

// ---- §9's hard block ----------------------------------------------------------------------------

export interface QaRecordCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Whether a QA outcome can be recorded as given.
 *
 * §9: "**`approved = true` cannot be saved without at least one evidence file.** Not a warning, a
 * hard block. An unevidenced approval is an assertion, and the whole point of the toggle is that it
 * is backed by something the client produced."
 *
 * This is the third time the same principle has decided a design in this module, and it is worth
 * naming as one rather than three coincidences:
 *
 *  - §6.2 gates mobilisation on the client's approval **document** as well as the status.
 *  - §5 settles a cash advance on receipts **in finance's hands**, not receipts typed into a form.
 *  - §9 refuses an approval with nothing behind it.
 *
 * In each case a status is something AIES set and the artefact is something somebody else produced,
 * and only the second survives an argument.
 *
 * §9 also anticipates the awkward case and answers it: "If the client approved verbally, the
 * Operations Manager writes it up, notes `evidenceType = other`, and uploads that — **a
 * contemporaneous note is weak evidence but it is evidence, and it is honest about what it is.**"
 * So the block is satisfiable in every real situation, which is what makes it fair to enforce.
 */
export function checkQaRecord(input: {
  approved: boolean;
  clientInspected: boolean;
  evidenceFileIds: readonly string[];
  evidenceType?: string | null;
  defects: readonly Defect[];
  remarks?: string | null;
}): QaRecordCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.approved && input.evidenceFileIds.length === 0) {
    errors.push(
      "An approval needs the client's own documentation attached. If they approved verbally, write " +
        "it up, upload the note and mark the evidence as 'other' — weak evidence honestly labelled " +
        "beats an assertion.",
    );
  }

  if (input.approved && !input.evidenceType) {
    errors.push("Say what kind of evidence this is — it is how somebody later judges its weight.");
  }

  if (input.evidenceType && !EVIDENCE_TYPES.includes(input.evidenceType as EvidenceType)) {
    errors.push(`"${input.evidenceType}" is not one of §9's evidence types.`);
  }

  /**
   * §9: "Where a client does not inspect at all, the Operations Manager records that fact explicitly
   * rather than leaving the gate blank — `evidenceType = other` with a note."
   *
   * A waiver with no note is a blank gate wearing a different label, which is precisely what §9 says
   * must not happen.
   */
  if (!input.clientInspected && !input.remarks?.trim()) {
    errors.push(
      "Say why the client did not inspect. A gate nobody explains is indistinguishable from one " +
        "nobody opened.",
    );
  }

  if (!input.approved && input.defects.length === 0) {
    errors.push(
      "A failed inspection needs at least one defect. 'They rejected it' with nothing listed gives " +
        "the crew nothing to put right.",
    );
  }

  const badSeverity = input.defects.find((defect) => !DEFECT_SEVERITIES.includes(defect.severity));
  if (badSeverity) {
    errors.push(`"${badSeverity.severity}" is not a defect severity.`);
  }

  if (input.defects.some((defect) => !defect.description?.trim())) {
    errors.push("Every defect needs a description.");
  }

  if (input.approved && input.defects.length > 0) {
    // Legitimate — a client can accept work with a punch list — but worth saying out loud, because
    // the defects still have to be closed and an approved gate makes them easy to forget.
    warnings.push(
      `Approved with ${input.defects.length} defect(s) outstanding. They stay on the punch list; ` +
        `approval is not closure.`,
    );
  }

  if (input.evidenceType === "other" && !input.remarks?.trim()) {
    warnings.push("Evidence marked 'other' with no remarks. Describe what was uploaded.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---- §9's rework loop ---------------------------------------------------------------------------

/** Defects that §9 says module 08 should raise an NCR for. */
export function ncrWorthyDefects(defects: readonly Defect[]): Defect[] {
  return defects.filter((defect) => defect.severity === "major" || defect.severity === "critical");
}

export interface QaOutcome {
  /** Where the ticket goes next. §9: the QA diamond "loops failures back to Project Execution". */
  ticketStatus: "tc" | "in_progress";
  reworkRound: number;
  message: string;
}

/**
 * What a recorded outcome does to the ticket.
 *
 * §9: "The flowchart's QA diamond loops failures back to Project Execution — **implement that
 * literally**." So a failure returns the ticket to `in_progress` rather than to some review state of
 * its own: the crew goes back and does the work again, which is what the flowchart draws.
 */
export function qaOutcome(input: {
  approved: boolean;
  previousRounds: number;
  defects: readonly Defect[];
}): QaOutcome {
  if (input.approved) {
    return {
      ticketStatus: "tc",
      reworkRound: input.previousRounds,
      message:
        input.previousRounds === 0
          ? "Approved first time. This is the first-time-right case §9 wants counted."
          : `Approved after ${input.previousRounds} round(s) of rework.`,
    };
  }

  const next = input.previousRounds + 1;
  const serious = ncrWorthyDefects(input.defects);

  return {
    ticketStatus: "in_progress",
    reworkRound: next,
    message:
      `Back to the crew — rework round ${next}, ${input.defects.length} defect(s)` +
      (serious.length > 0
        ? `, ${serious.length} of them major or critical. Module 08 raises an NCR for those when it exists.`
        : "."),
  };
}

// ---- §9's metric --------------------------------------------------------------------------------

export interface FirstTimeRight {
  total: number;
  firstTimeRight: number;
  /** Percent, or null when nothing has been inspected — a rate over zero jobs is not 100%. */
  ratePct: number | null;
  message: string;
}

/**
 * §9: "First-time-right (module 09) is `reworkRound = 0`. **This is the quality metric that matters
 * most and is currently unmeasurable.**"
 *
 * Counted over *approved* records only. A job still going round the rework loop is not yet a failure
 * of first-time-right — it might still be approved on round two — and counting it early would make
 * the number move backwards as work finishes, which is the fastest way to make a metric distrusted.
 */
export function firstTimeRightRate(
  records: readonly { approved: boolean; reworkRound: number }[],
): FirstTimeRight {
  const finished = records.filter((record) => record.approved);
  const total = finished.length;
  const firstTimeRight = finished.filter((record) => record.reworkRound === 0).length;

  if (total === 0) {
    return {
      total: 0,
      firstTimeRight: 0,
      ratePct: null,
      message: "Nothing has been through client QA yet, so there is no rate to report.",
    };
  }

  const ratePct = Math.round((firstTimeRight / total) * 1000) / 10;
  return {
    total,
    firstTimeRight,
    ratePct,
    message: `${firstTimeRight} of ${total} approved first time — ${ratePct}%.`,
  };
}
