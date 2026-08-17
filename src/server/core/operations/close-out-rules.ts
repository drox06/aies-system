/**
 * Service report and project close-out (specs/04-operations-projects.md §12).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §12: "Approval emits `project.closed` → module 05 releases final billing. **This is the explicit
 * handover the brief describes.**"
 *
 * That sentence sets the standard for everything here. A handover is not a formality somebody clicks
 * through; it is the moment the company says the work is finished and asks to be paid for it. So the
 * blockers are **computed from what the other sections recorded**, never ticked by hand — a
 * checklist a project manager can tick past is a checklist that says nothing.
 */

export const SERVICE_REPORT_ENTITY_TYPE = "ServiceReport";
export const SERVICE_REPORT_DOCUMENT_TYPE = "service_report";
export const CLOSE_OUT_ENTITY_TYPE = "ProjectCloseOut";

/** §19: `service_report.approve` · `project.close`. */
export const SERVICE_REPORT_APPROVE_PERMISSION = "service_report.approve";
export const PROJECT_CLOSE_PERMISSION = "project.close";

/** §12's status flow. */
export const SERVICE_REPORT_STATUSES = [
  "draft",
  "pending_signature",
  "signed",
  "submitted",
  "approved",
] as const;
export type ServiceReportStatus = (typeof SERVICE_REPORT_STATUSES)[number];

export const SERVICE_REPORT_STATUS_LABELS: Record<ServiceReportStatus, string> = {
  draft: "Draft",
  pending_signature: "Waiting for the customer to sign",
  signed: "Signed by the customer",
  submitted: "Submitted for approval",
  approved: "Approved",
};

export const CLOSE_OUT_STATUSES = ["in_progress", "submitted", "approved"] as const;
export type CloseOutStatus = (typeof CLOSE_OUT_STATUSES)[number];

// ---- the service report --------------------------------------------------------------------------

export interface PartUsed {
  description: string;
  partNumber?: string | null;
  quantity: number;
  unit?: string | null;
  fromStock?: boolean;
  stockItemId?: string | null;
}

export interface ServiceReportCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Whether a service report can move to the status asked for.
 *
 * The rule that carries weight: **`signed` needs the customer's signature**, or an explicit reason
 * there is none. §12 has the customer signing on the technician's device, and a report AIES signed
 * alone is AIES's account of its own work. Same standard as §5's receipts, §6.2's approval document,
 * §9's evidence and §10's certificate — and satisfiable the same way, by saying honestly that there
 * is no signature and why.
 */
export function checkServiceReport(input: {
  target: ServiceReportStatus;
  workPerformed: string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  customerSignatureFileId?: string | null;
  signatureWaiverReason?: string | null;
  customerName?: string | null;
  followUpRequired: boolean;
  followUpNotes?: string | null;
  partsUsed?: readonly PartUsed[];
}): ServiceReportCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.workPerformed?.trim()) {
    errors.push("A service report needs the work described. It is the record of what was done.");
  }

  const beyondDraft = input.target !== "draft";

  if (beyondDraft && !input.finishedAt) {
    errors.push("Say when the work finished before sending this to the customer.");
  }

  if (
    input.startedAt &&
    input.finishedAt &&
    new Date(input.finishedAt).getTime() < new Date(input.startedAt).getTime()
  ) {
    errors.push("The work finished before it started. Check the times.");
  }

  if (input.target === "signed" || input.target === "submitted" || input.target === "approved") {
    if (!input.customerSignatureFileId && !input.signatureWaiverReason?.trim()) {
      errors.push(
        "A signed report needs the customer's signature, or a written reason there is none. " +
          "Without either it is AIES's account of its own work.",
      );
    }
    if (input.customerSignatureFileId && !input.customerName?.trim()) {
      errors.push("Name who signed. A signature nobody can attribute is not much of one.");
    }
  }

  /**
   * §12 carries `followUpRequired` as its own field rather than leaving it in the narrative, which
   * only helps if the follow-up is actually described — otherwise it is a flag nobody can act on.
   */
  if (input.followUpRequired && !input.followUpNotes?.trim()) {
    errors.push("Say what the follow-up is. A flag with no description is not a handover.");
  }

  for (const part of input.partsUsed ?? []) {
    if (!part.description?.trim()) errors.push("Every part used needs a description.");
    if (!(part.quantity > 0)) errors.push(`"${part.description}" needs a quantity above zero.`);
  }

  if (beyondDraft && !input.signatureWaiverReason && !input.customerSignatureFileId) {
    // Deliberately only a warning at pending_signature — that status exists precisely for the gap
    // between finishing the work and getting the signature.
    if (input.target === "pending_signature") {
      warnings.push("Nobody has signed yet. That is what this status is for.");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---- §12's close-out blockers ---------------------------------------------------------------------

/**
 * The six blockers §12 names, as a closed list.
 *
 * §20 requires each to block independently and unblock in isolation, which is why every one is
 * computed separately and reported separately rather than being folded into a single verdict. A
 * project manager who is told "close-out is blocked" learns nothing; one who is told which of the
 * six, and whose it is, can go and do something about it.
 */
export const CLOSE_OUT_BLOCKERS = [
  "critical_punch_items",
  "unapproved_service_reports",
  "failed_qa",
  "unliquidated_cash_advances",
  "unreturned_tools",
  "missing_customer_acceptance",
] as const;
export type CloseOutBlockerKey = (typeof CLOSE_OUT_BLOCKERS)[number];

export interface BlockerState {
  key: CloseOutBlockerKey;
  label: string;
  /** True when this one is holding close-out up. */
  blocking: boolean;
  /** What exactly, in words the person who has to fix it can act on. */
  detail: string;
  /** §12: "so the PM can see who owns each one." */
  owner: string;
  /** How many things are outstanding, where counting means anything. */
  count: number;
}

export interface CloseOutInput {
  /** §10's open critical punch items across the project's commissioning records. */
  criticalPunchItems: number;
  /** Service reports on the project that are not yet approved. */
  unapprovedServiceReports: number;
  /** §9 records whose latest verdict is a rejection. */
  failedQa: number;
  /** §5 advances released and not yet settled. */
  unliquidatedCashAdvances: number;
  /** §7 returnable items issued and not returned. */
  unreturnedTools: number;
  customerAcceptanceRequired: boolean;
  customerAcceptanceFileId?: string | null;
  acceptanceWaiverReason?: string | null;
}

/**
 * Works out which of §12's six blockers are holding a project open.
 *
 * Every blocker is returned whether or not it is blocking, because the checklist §12 asks for is as
 * much about what is *done* as what is outstanding — a PM looking at five green rows and one red one
 * knows where to go. A list containing only problems makes it impossible to tell "clear" from "not
 * checked".
 */
export function closeOutChecklist(input: CloseOutInput): BlockerState[] {
  const acceptanceSatisfied =
    !input.customerAcceptanceRequired ||
    !!input.customerAcceptanceFileId ||
    !!input.acceptanceWaiverReason?.trim();

  return [
    {
      key: "critical_punch_items",
      label: "Critical punch items closed",
      blocking: input.criticalPunchItems > 0,
      count: input.criticalPunchItems,
      owner: "Operations — whoever owns each item",
      detail:
        input.criticalPunchItems > 0
          ? `${input.criticalPunchItems} critical punch item(s) still open from commissioning.`
          : "No critical punch items outstanding.",
    },
    {
      key: "unapproved_service_reports",
      label: "Service reports approved",
      blocking: input.unapprovedServiceReports > 0,
      count: input.unapprovedServiceReports,
      owner: "Operations Manager",
      detail:
        input.unapprovedServiceReports > 0
          ? `${input.unapprovedServiceReports} service report(s) not yet approved.`
          : "Every service report is approved.",
    },
    {
      key: "failed_qa",
      label: "QA passed",
      blocking: input.failedQa > 0,
      count: input.failedQa,
      owner: "Operations — the crew, then the client",
      detail:
        input.failedQa > 0
          ? `${input.failedQa} ticket(s) whose last QA verdict was a rejection.`
          : "No outstanding QA rejections.",
    },
    {
      key: "unliquidated_cash_advances",
      label: "Cash advances liquidated",
      blocking: input.unliquidatedCashAdvances > 0,
      count: input.unliquidatedCashAdvances,
      owner: "Finance, and the holder of each advance",
      detail:
        input.unliquidatedCashAdvances > 0
          ? `${input.unliquidatedCashAdvances} advance(s) released and not settled.`
          : "Every advance is settled.",
    },
    {
      key: "unreturned_tools",
      label: "Tools returned",
      blocking: input.unreturnedTools > 0,
      count: input.unreturnedTools,
      owner: "The store, and whoever drew them",
      detail:
        input.unreturnedTools > 0
          ? `${input.unreturnedTools} returnable item(s) still out.`
          : "Nothing outstanding from the store.",
    },
    {
      key: "missing_customer_acceptance",
      label: "Customer acceptance",
      blocking: !acceptanceSatisfied,
      count: acceptanceSatisfied ? 0 : 1,
      owner: "Project Manager",
      detail: !input.customerAcceptanceRequired
        ? "Not required on this project."
        : input.customerAcceptanceFileId
          ? "Customer acceptance certificate on file."
          : input.acceptanceWaiverReason?.trim()
            ? `Waived: ${input.acceptanceWaiverReason}`
            : "No customer acceptance certificate, and it has not been waived.",
    },
  ];
}

export interface CloseOutVerdict {
  canClose: boolean;
  blockers: BlockerState[];
  cleared: BlockerState[];
  message: string;
}

export function closeOutVerdict(checklist: readonly BlockerState[]): CloseOutVerdict {
  const blockers = checklist.filter((entry) => entry.blocking);
  const cleared = checklist.filter((entry) => !entry.blocking);

  return {
    canClose: blockers.length === 0,
    blockers: [...blockers],
    cleared,
    message:
      blockers.length === 0
        ? "Everything §12 asks for is in place. Closing emits project.closed, which is what releases final billing."
        : `${blockers.length} of ${checklist.length} blocker(s) outstanding: ` +
          blockers.map((entry) => entry.label.toLowerCase()).join(", ") +
          ".",
  };
}

/**
 * §12's close-out pack contents, as a list rather than prose.
 *
 * The pack itself is a PDF and is not built yet. The list is here because it is the answer to "what
 * has to exist before this project can be handed over", and having it in code — where the screen can
 * show it and a later session can walk it — is worth more than having it only in the spec.
 */
export const CLOSE_OUT_PACK_CONTENTS = [
  "Cover sheet",
  "Scope summary",
  "Approved methodology",
  "Site inspection report",
  "Delivery receipts",
  "Material list",
  "QA records",
  "T&C certificate and test results",
  "Service reports",
  "Calibration and test certificates",
  "As-built documentation",
  "Spare parts list",
  "Warranty statement",
  "Training record",
  "Punch list closure",
  "Customer acceptance certificate",
] as const;
