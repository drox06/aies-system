/**
 * Mobilisation rules (specs/04-operations-projects.md §8).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * This is where the previous four sessions converge. §5's cash advance gate, §6.2's methodology gate
 * and §7's material gate were each built and left inert, returning a verdict rather than throwing,
 * specifically so that this file could ask them rather than re-deciding what they already decided.
 * Every one of them is called here and none of their logic is repeated.
 */

import { methodStatementRequiredFor } from "./methodology-rules";

export const MOBILIZATION_ENTITY_TYPE = "Mobilization";

/**
 * §19's permissions. Dispatching is a different act from executing.
 *
 * There is deliberately **no** "override the readiness check" permission. §19 does not list one, and
 * inventing one would be a second, blunter way past gates that already have their own escape hatches:
 * `operations.override_ca_gate` and `operations.override_methodology_gate`. §7's material gate has no
 * override because §7 does not offer one, and that is the spec's choice rather than an omission.
 */
export const MOBILIZE_PERMISSION = "ticket.dispatch";
export const EXECUTE_PERMISSION = "ticket.execute";

export const MOBILIZATION_TYPES = ["mobilization", "demobilization"] as const;
export type MobilizationType = (typeof MOBILIZATION_TYPES)[number];

export const MOBILIZATION_STATUSES = [
  "planned",
  "ready",
  "departed",
  "on_site",
  "returned",
  "cancelled",
] as const;
export type MobilizationStatus = (typeof MOBILIZATION_STATUSES)[number];

/** §8's three-state fields. `not_required` is a recorded answer, the same as §7's N/A. */
export const CLEARANCE_STATES = ["not_required", "pending", "obtained"] as const;
export type ClearanceState = (typeof CLEARANCE_STATES)[number];

// ---- §8's readiness check -----------------------------------------------------------------------

export interface ReadinessItem {
  key: string;
  label: string;
  /** pass | fail | not_applicable | unknown. */
  state: "pass" | "fail" | "not_applicable" | "unknown";
  /**
   * Mandatory items decide whether `ready_to_mobilize` is reachable. §8: "`ready_to_mobilize` is
   * only reachable when **all mandatory items pass**."
   */
  mandatory: boolean;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  items: ReadinessItem[];
  /** The mandatory items that are not passing — what somebody has to go and fix. */
  blockers: ReadinessItem[];
}

export interface ReadinessInput {
  ticketType: string;
  /** The verdicts from §5, §6.2 and §7, passed in rather than recomputed. */
  cashAdvance: { blocks: boolean; message: string };
  materials: { blocks: boolean; message: string };
  methodology: { blocks: boolean; message: string };
  /**
   * Gates an officer has already overridden, by key, with the reason they gave.
   *
   * Without this the overrides built in sessions 2 and 4 would let nobody through: they move the
   * ticket's status but the gate functions still read the underlying record and still say no. An
   * escape hatch that does not open anything is worse than none, because somebody uses it and
   * believes they are through.
   */
  overrides?: Partial<Record<"cash_advance" | "methodology", string>>;
  crewIds: readonly string[];
  gatePassStatus: string;
  permitStatus: string;
  inductionCompleted: boolean;
  toolsChecklist: readonly { label: string; checked: boolean }[];
  ppeChecklist: readonly { label: string; checked: boolean }[];
  customerContactConfirmed: boolean;
}

/**
 * §8's green/red list.
 *
 * ## What is mandatory, and what is only shown
 *
 * The three gates are mandatory because three earlier sections say so in as many words — money in
 * hand, materials issued, and (for a new project) a method statement the client approved. Crew,
 * PPE and the customer contact are mandatory because a crew of nobody, in no protective equipment,
 * arriving unannounced, is not a mobilisation.
 *
 * Gate passes and permits are **conditionally** mandatory: `not_required` is a recorded answer and
 * passes, `pending` fails, `obtained` passes. That mirrors §7's N/A exactly — the site that needs no
 * permit and the site nobody has asked about must not look the same.
 *
 * Crew competence is listed as `unknown` and **not** mandatory. §8 wants it checked against module
 * 08, which does not exist; asserting a pass would be a lie and asserting a fail would block every
 * mobilisation. Showing it as unanswered is the honest third option, and it is visible on the list
 * so nobody mistakes its absence for a tick.
 */
export function mobilizationReadiness(input: ReadinessInput): Readiness {
  const items: ReadinessItem[] = [];

  const caOverride = input.overrides?.cash_advance;
  items.push({
    key: "cash_advance",
    label: "Cash advance released",
    state: !input.cashAdvance.blocks ? "pass" : caOverride ? "pass" : "fail",
    mandatory: true,
    detail: caOverride ? `Overridden by an officer — ${caOverride}` : input.cashAdvance.message,
  });

  /**
   * Whether this kind of job takes a method statement at all — asked of the rule that owns the
   * question rather than answered again here.
   *
   * This used to read `input.ticketType === "new_project"`, which was §6's wording taken literally
   * and had already drifted from the gate on the ticket's own panel: readiness called a delivery
   * "not applicable" while `methodologyGate` called the same job "blocked". One screen contradicting
   * another about one job is worse than either answer alone, because it teaches people that the
   * gates are noise.
   *
   * The shared predicate also carries the company's 2026-08-19 correction — installations take one
   * too, and their testing and commissioning comes with them.
   */
  const needsMethod = methodStatementRequiredFor(input.ticketType);
  const methodOverride = input.overrides?.methodology;
  items.push({
    key: "methodology",
    label: "Method statement approved by the client",
    state: !needsMethod
      ? "not_applicable"
      : !input.methodology.blocks
        ? "pass"
        : methodOverride
          ? "pass"
          : "fail",
    mandatory: needsMethod,
    detail: !needsMethod
      ? "Only new projects take §6's branch. Nothing is waiting on a method statement."
      : methodOverride
        ? `Overridden by an officer — ${methodOverride}`
        : input.methodology.message,
  });

  /*
    Materials come after the method statement, because that is the order the job happens in.

    The method statement is what says which materials the job needs; issuing stock before it is
    approved is guessing. The list used to read cash advance → materials → method statement, which
    is neither the order of the work nor the order of the panels on the ticket, and the company
    asked for the two to match. A readiness list that disagrees with the screen it sits on teaches
    people to read it as a bag of unrelated checks rather than as a sequence.
  */
  items.push({
    key: "materials",
    label: "Materials issued",
    state: input.materials.blocks ? "fail" : "pass",
    mandatory: true,
    detail: input.materials.message,
  });

  items.push({
    key: "crew",
    label: "Crew assigned",
    state: input.crewIds.length > 0 ? "pass" : "fail",
    mandatory: true,
    detail:
      input.crewIds.length > 0
        ? `${input.crewIds.length} on the crew.`
        : "Nobody is assigned. A mobilisation with no crew is a van leaving empty.",
  });

  items.push({
    key: "competence",
    label: "Crew competent for this work",
    // Module 08 owns competence and does not exist. Unknown rather than a guess in either direction.
    state: "unknown",
    mandatory: false,
    detail:
      "Module 08 holds competence records and is not built. Check by eye until it is — this line " +
      "is here so its absence is visible rather than assumed.",
  });

  items.push(clearanceItem("gate_pass", "Gate pass", input.gatePassStatus));
  items.push(clearanceItem("permits", "Permits", input.permitStatus));

  items.push({
    key: "induction",
    label: "Site induction completed",
    state: input.inductionCompleted ? "pass" : "fail",
    // Not mandatory: plenty of sites require none, and there is no way to tell from here which. It
    // is on the list so somebody looks rather than so the system refuses.
    mandatory: false,
    detail: input.inductionCompleted
      ? "Done."
      : "Not recorded. Many sites require one before anybody passes the gate.",
  });

  const toolsChecked = input.toolsChecklist.every((entry) => entry.checked);
  items.push({
    key: "tools",
    label: "Tools checked out",
    state: input.toolsChecklist.length === 0 ? "unknown" : toolsChecked ? "pass" : "fail",
    mandatory: input.toolsChecklist.length > 0,
    detail:
      input.toolsChecklist.length === 0
        ? "No tools checklist on this mobilisation."
        : toolsChecked
          ? "Every item ticked."
          : `${input.toolsChecklist.filter((e) => !e.checked).length} item(s) not ticked.`,
  });

  const ppeChecked = input.ppeChecklist.every((entry) => entry.checked);
  items.push({
    key: "ppe",
    label: "PPE confirmed",
    state: input.ppeChecklist.length === 0 ? "fail" : ppeChecked ? "pass" : "fail",
    // Always mandatory, including the empty case: an empty PPE checklist is not a crew that needs
    // none, it is a checklist nobody filled in.
    mandatory: true,
    detail:
      input.ppeChecklist.length === 0
        ? "No PPE checklist. An empty list is not the same as no PPE required."
        : ppeChecked
          ? "Confirmed."
          : `${input.ppeChecklist.filter((e) => !e.checked).length} item(s) not confirmed.`,
  });

  items.push({
    key: "customer_contact",
    label: "Customer contact confirmed",
    state: input.customerContactConfirmed ? "pass" : "fail",
    mandatory: true,
    detail: input.customerContactConfirmed
      ? "Somebody at the site knows the crew is coming."
      : "Nobody has confirmed the site is expecting them. This is the cheapest wasted day to avoid.",
  });

  const blockers = items.filter((item) => item.mandatory && item.state !== "pass");

  return { ready: blockers.length === 0, items, blockers };
}

/**
 * A gate pass or permit, where "not required" is an answer.
 *
 * The same shape as §7's N/A: a site that needs no permit and a site nobody has asked about must not
 * look alike on the list, because only one of them is a problem.
 */
function clearanceItem(key: string, label: string, state: string): ReadinessItem {
  if (state === "not_required") {
    return {
      key,
      label,
      state: "not_applicable",
      mandatory: false,
      detail: "Recorded as not required for this site.",
    };
  }
  if (state === "obtained") {
    return { key, label, state: "pass", mandatory: true, detail: "Obtained." };
  }
  return {
    key,
    label,
    state: "fail",
    mandatory: true,
    detail:
      "Still pending. Site access is refused for want of this more often than for anything technical.",
  };
}

// ---- demobilisation -----------------------------------------------------------------------------

export interface DemobChecklist {
  /** True when nothing issued is still unaccounted for. */
  toolsReconciled: boolean;
  outstandingCount: number;
  message: string;
}

/**
 * §8: "Demobilization closes the loop: **tools returned and reconciled against the material
 * request**…"
 *
 * Reported rather than enforced. A crew that lost a tool still has to demobilise — refusing would
 * leave the ticket open forever and the loss unrecorded, which is worse than recording both. What
 * this produces is a demobilisation that says, on the record, what did not come back.
 */
export function demobChecklist(
  outstanding: readonly { description: string; outstanding: number }[],
): DemobChecklist {
  if (outstanding.length === 0) {
    return {
      toolsReconciled: true,
      outstandingCount: 0,
      message: "Everything issued has been returned or accounted for.",
    };
  }

  return {
    toolsReconciled: false,
    outstandingCount: outstanding.length,
    message:
      `${outstanding.length} item(s) issued to this ticket have not come back: ` +
      `${outstanding.map((line) => line.description).join(", ")}. Demobilising anyway records the ` +
      `loss rather than hiding it — they stay on the custody list.`,
  };
}
