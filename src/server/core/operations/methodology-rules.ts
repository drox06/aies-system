/**
 * Methodology rules (specs/04-operations-projects.md §6.2).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §6.2 states the commercial point plainly, and it is what the dates in this file are for: "Client
 * methodology approval is a common and invisible source of schedule slip, and AIES is usually blamed
 * for delays it did not cause. **A dated submission record changes that conversation.**"
 */

export const METHODOLOGY_ENTITY_TYPE = "Methodology";
export const METHODOLOGY_DOCUMENT_TYPE = "methodology";

/** §19's permissions. `methodology.approve` is the internal sign-off, before the client ever sees it. */
export const METHODOLOGY_PREPARE_PERMISSION = "methodology.prepare";
export const METHODOLOGY_APPROVE_PERMISSION = "methodology.approve";
/** §6.2: "president and VP only", and logged with a reason. */
export const METHODOLOGY_GATE_OVERRIDE_PERMISSION = "operations.override_methodology_gate";

/** §6.2's status vocabulary, in the order one moves through it. */
export const METHODOLOGY_STATUSES = [
  "draft",
  "internal_review",
  "approved",
  "submitted_to_client",
  "client_approved",
  "client_rejected",
  "superseded",
] as const;

export type MethodologyStatus = (typeof METHODOLOGY_STATUSES)[number];

/**
 * What may follow what.
 *
 * `client_rejected` goes nowhere: §6.2 says a rejection "returns the methodology to draft **and
 * creates a revision**", so the rejected document stays rejected forever and R+1 starts as a draft.
 * That is what makes the chain evidence — a document that could be edited back into acceptability
 * would prove nothing about what the client actually turned down.
 */
export const METHODOLOGY_TRANSITIONS: Record<MethodologyStatus, readonly MethodologyStatus[]> = {
  draft: ["internal_review", "superseded"],
  internal_review: ["approved", "draft"],
  approved: ["submitted_to_client", "draft"],
  submitted_to_client: ["client_approved", "client_rejected"],
  client_approved: ["superseded"],
  client_rejected: ["superseded"],
  superseded: [],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = METHODOLOGY_TRANSITIONS[from as MethodologyStatus];
  return !!allowed && allowed.includes(to as MethodologyStatus);
}

/** Editable while it is still AIES's document. Once it has gone out, a change is a revision. */
export function isMethodologyEditable(status: string): boolean {
  return status === "draft" || status === "internal_review";
}

// ---- what a method statement has to say before anybody reviews it -------------------------------

export interface MethodologyCompleteness {
  complete: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Whether there is enough here to send for internal review.
 *
 * The required set is deliberately the four things that make a method statement a method statement
 * rather than a title: what the work is, the order it happens in, who does it, and how it is done
 * safely. A utility that asks for a method statement is asking for those.
 *
 * Everything else warns. `durationDays` in particular is a warning and not a block, because a
 * survey-first job legitimately does not know it yet, and forcing a number produces a fictional one
 * — which is worse than a blank, since the schedule gets built on it.
 */
export function methodologyCompleteness(methodology: {
  scopeSummary: string | null;
  sequenceOfWork?: unknown;
  manpowerPlan?: unknown;
  safetyPlan: string | null;
  durationDays: number | null;
  toolsRequired: readonly string[];
  materialsRequired?: unknown;
  permitsRequired: readonly string[];
}): MethodologyCompleteness {
  const missing: string[] = [];
  const warnings: string[] = [];

  const steps = Array.isArray(methodology.sequenceOfWork) ? methodology.sequenceOfWork : [];
  const crew = Array.isArray(methodology.manpowerPlan) ? methodology.manpowerPlan : [];
  const materials = Array.isArray(methodology.materialsRequired)
    ? methodology.materialsRequired
    : [];

  if (!methodology.scopeSummary?.trim()) missing.push("a scope summary");
  if (steps.length === 0) missing.push("the sequence of work — at least one step");
  if (crew.length === 0) missing.push("the manpower plan — who is doing it");
  if (!methodology.safetyPlan?.trim()) missing.push("the safety plan");

  if (methodology.durationDays === null) {
    warnings.push("No duration. The schedule will be built on whatever somebody assumes instead.");
  }
  if (methodology.toolsRequired.length === 0 && materials.length === 0) {
    // §6.2: these lists pre-populate §7's material request. An empty one is not wrong — a
    // labour-only job needs nothing — but it does mean somebody will be typing it again later.
    warnings.push(
      "No tools or materials listed. These pre-populate the material request, so an empty list " +
        "means that gets typed from scratch.",
    );
  }
  if (methodology.permitsRequired.length === 0) {
    warnings.push("No permits listed. Confirm none are needed rather than leaving it unanswered.");
  }

  return { complete: missing.length === 0, missing, warnings };
}

// ---- §6.2's gate --------------------------------------------------------------------------------

export type MethodologyGateState = "not_required" | "satisfied" | "blocked";

export interface MethodologyGate {
  state: MethodologyGateState;
  blocks: boolean;
  message: string;
}

/**
 * §6.2: "Mobilization is blocked until `status = client_approved` **and** the client's approval
 * document is attached."
 *
 * Both halves, and the second is the one worth defending. A status is something an AIES employee
 * set; the document is something the client signed. Gating on the status alone would let the company
 * mobilise on somebody's recollection of a phone call — which is exactly the dispute this section
 * exists to win, and it would lose it.
 *
 * The same reasoning appears in §5's liquidation, where filing receipts in the app is a claim and
 * the paper is the proof (docs/DECISIONS.md #63).
 *
 * ## Inert today, deliberately
 *
 * Mobilization is §8's and does not exist. This returns a verdict rather than throwing, and §8 calls
 * it rather than writing a second, subtly different answer — the same shape as §5's cash advance
 * gate and module 03's downpayment gate.
 */
export function methodologyGate(
  methodology: {
    status: string;
    clientApprovalRequired: boolean;
    clientApprovalFileId: string | null;
    submittedToClientAt: Date | string | null;
  } | null,
): MethodologyGate {
  if (!methodology) {
    // A project with no method statement at all. §6 puts one before the work on a new project, so
    // this is blocked rather than "not required" — the absence is the problem.
    return {
      state: "blocked",
      blocks: true,
      message:
        "No method statement. §6 puts one before the work starts on a new project — prepare it, " +
        "get it approved internally, and send it to the client.",
    };
  }

  if (!methodology.clientApprovalRequired) {
    return {
      state: "not_required",
      blocks: false,
      message:
        "This customer does not require method statement approval. Recorded as an exception, with " +
        "a reason — it is not the normal case.",
    };
  }

  if (methodology.status === "client_approved" && methodology.clientApprovalFileId) {
    return {
      state: "satisfied",
      blocks: false,
      message: "The client has approved the method statement, and their approval is on file.",
    };
  }

  if (methodology.status === "client_approved") {
    return {
      state: "blocked",
      blocks: true,
      message:
        "Marked client-approved, but their approval document is not attached. §6.2 wants both — " +
        "a status is something we set, and the document is something they signed.",
    };
  }

  if (methodology.status === "submitted_to_client") {
    const days = methodology.submittedToClientAt
      ? Math.floor((Date.now() - new Date(methodology.submittedToClientAt).getTime()) / 86_400_000)
      : 0;
    return {
      state: "blocked",
      blocks: true,
      message:
        `With the client for ${days} day${days === 1 ? "" : "s"}. Nothing mobilises until they ` +
        `approve it — and this date is what shows the delay was theirs.`,
    };
  }

  if (methodology.status === "client_rejected") {
    return {
      state: "blocked",
      blocks: true,
      message:
        "The client rejected the method statement. A revision was raised from it — work that one " +
        "through and send it back.",
    };
  }

  return {
    state: "blocked",
    blocks: true,
    message:
      `The method statement is ${methodology.status.replace(/_/g, " ")}. It has not been sent to ` +
      `the client yet, so nothing can mobilise.`,
  };
}

// ---- §6.2's turnaround --------------------------------------------------------------------------

export interface Turnaround {
  /** Days between submission and the client's answer, or to today while it is still out. */
  days: number | null;
  /** True while the clock is still running. */
  pending: boolean;
  message: string;
}

/**
 * How long the client has had it (§6.2).
 *
 * Calendar days rather than working days, deliberately — unlike everything else in this build. This
 * number is used in a conversation with a customer about why a job slipped, and "seventeen days"
 * is a fact they recognise where "eleven working days" invites an argument about whose calendar.
 */
export function clientTurnaround(
  methodology: {
    submittedToClientAt: Date | string | null;
    clientApprovedAt: Date | string | null;
    status: string;
  },
  now: Date = new Date(),
): Turnaround {
  if (!methodology.submittedToClientAt) {
    return { days: null, pending: false, message: "Not yet sent to the client." };
  }

  const submitted = new Date(methodology.submittedToClientAt).getTime();
  const answered = methodology.clientApprovedAt
    ? new Date(methodology.clientApprovedAt).getTime()
    : null;

  if (answered !== null) {
    const days = Math.max(0, Math.floor((answered - submitted) / 86_400_000));
    return {
      days,
      pending: false,
      message: `The client took ${days} day${days === 1 ? "" : "s"} to approve it.`,
    };
  }

  if (methodology.status === "client_rejected") {
    const days = Math.max(0, Math.floor((now.getTime() - submitted) / 86_400_000));
    return { days, pending: false, message: `Rejected after ${days} day${days === 1 ? "" : "s"}.` };
  }

  const days = Math.max(0, Math.floor((now.getTime() - submitted) / 86_400_000));
  return {
    days,
    pending: true,
    message: `With the client for ${days} day${days === 1 ? "" : "s"}, unanswered.`,
  };
}

// ---- §7's head start ----------------------------------------------------------------------------

export interface MaterialLine {
  description: string;
  quantity: string;
  unit: string;
}

/**
 * The tools and materials a material request should start from (§6.2).
 *
 * §6.2: "The tools and materials lists here **pre-populate the material request** in §7. Nobody
 * should type the same list twice."
 *
 * §7 does not exist. This is exported now anyway, and shaped as §7 will want it, so that the session
 * which builds the material request finds the answer already written and tested rather than
 * inventing a second reading of the same two columns.
 */
export function materialRequestSeed(methodology: {
  toolsRequired: readonly string[];
  materialsRequired?: unknown;
}): MaterialLine[] {
  const materials = Array.isArray(methodology.materialsRequired)
    ? (methodology.materialsRequired as MaterialLine[])
    : [];

  const fromMaterials = materials
    .filter((line) => line && typeof line.description === "string" && line.description.trim())
    .map((line) => ({
      description: line.description.trim(),
      quantity: String(line.quantity ?? "1"),
      unit: String(line.unit ?? "pc"),
    }));

  // Tools carry no quantity on the methodology — they are a checklist, not a bill of materials — so
  // they arrive as one each, which is what somebody packing a van needs.
  const fromTools = methodology.toolsRequired
    .filter((tool) => tool.trim())
    .map((tool) => ({ description: tool.trim(), quantity: "1", unit: "set" }));

  return [...fromMaterials, ...fromTools];
}
