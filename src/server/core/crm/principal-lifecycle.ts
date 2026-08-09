/**
 * The principal-prospect pipeline (specs/01-crm-inquiry.md §5c).
 *
 * Pure rules — no Prisma — so the UI shares them with the server. Same split as
 * inquiry-lifecycle.ts, and now enforced by the `no-restricted-imports` rule in eslint.config.mjs.
 *
 * §5c asks for "the same treatment as the sales pipeline", so the shape deliberately mirrors §3's:
 * an explicit transition map rather than a free-form stage column. The difference is that this
 * pipeline is genuinely non-linear — a principal can go quiet at any point and come back — so the
 * map is looser on purpose, and that looseness is a decision rather than an oversight.
 */

/**
 * The entityType principal files are stored under, so the upload endpoint and the access checker
 * agree on one string.
 *
 * Here rather than in principal-service.ts, mirroring ACCREDITATION_ENTITY_TYPE in
 * accreditation-rules.ts — and for a concrete reason. The checker has to be imported by the service
 * for its registration side effect, so if the checker also read this constant *from* the service
 * the two would form a cycle. That is not theoretical: it was written that way first and
 * `next build` died with "Cannot access 'k' before initialization", because the checker calls
 * `registerFileAccessChecker(PRINCIPAL_ENTITY_TYPE, ...)` at module-evaluation time, before the
 * service has finished initialising.
 */
export const PRINCIPAL_ENTITY_TYPE = "PrincipalProspect";

export const PRINCIPAL_STAGES = [
  "identified",
  "contacted",
  "in_discussion",
  "samples_pricing",
  "agreement_draft",
  "appointed",
  "declined",
  "dormant",
] as const;

export type PrincipalStage = (typeof PRINCIPAL_STAGES)[number];

/**
 * The only stage nothing moves out of.
 *
 * `declined` used to be here too, on the reasoning that a manufacturer which said no is a new
 * conversation rather than a resumed one. The company asked for it back as an emergency undo, and
 * they are right: `declined` is one click away from every live stage, so a misclick is easy and
 * previously permanent — the record had to be abandoned and retyped, losing its history. Reviving
 * is audited like any other move, so the mistake and its correction both stay on the record.
 */
export const PRINCIPAL_TERMINAL_STAGES: readonly PrincipalStage[] = ["appointed"];

export const EXCLUSIVITY_TERMS = ["none", "territory", "segment"] as const;

/** The forward path §5c lists, in order. */
const PROGRESSION: PrincipalStage[] = [
  "identified",
  "contacted",
  "in_discussion",
  "samples_pricing",
  "agreement_draft",
  "appointed",
];

export interface PrincipalTransitionCheck {
  ok: boolean;
  reason?: string;
}

export function humanStage(stage: string): string {
  return stage.replace(/_/g, " ");
}

/**
 * Whether a stage change is allowed.
 *
 * Three rules, and the reasoning for each:
 *
 * 1. **Forward only along the progression, one step at a time.** Skipping from `contacted` straight
 *    to `appointed` would mean an appointment with no record of samples, pricing or a drafted
 *    agreement — and §5c wants attribution ("which appointments actually earned their keep"), which
 *    needs the stages to have actually happened.
 * 2. **`declined` and `dormant` are reachable from anywhere** that is not already terminal. A
 *    manufacturer can say no at any point, and going quiet is not a failure state — §5c lists
 *    `dormant` precisely so a prospect can be parked without being lost.
 * 3. **`dormant` can be revived to where it left off**, so it is not terminal. `declined` is: a
 *    manufacturer that said no is a new conversation if it changes its mind, not a resumed one.
 *
 * Backward moves are refused. A stage that can go backwards is a stage nobody trusts in a report,
 * and the honest way to record "this stalled" is `dormant`.
 */
export function checkPrincipalTransition(from: string, to: string): PrincipalTransitionCheck {
  if (from === to) {
    return { ok: false, reason: `This prospect is already ${humanStage(to)}.` };
  }
  if (!PRINCIPAL_STAGES.includes(to as PrincipalStage)) {
    return { ok: false, reason: `"${to}" is not a pipeline stage.` };
  }
  if (!PRINCIPAL_STAGES.includes(from as PrincipalStage)) {
    return { ok: false, reason: `"${from}" is not a pipeline stage.` };
  }

  if (PRINCIPAL_TERMINAL_STAGES.includes(from as PrincipalStage)) {
    return {
      ok: false,
      reason: "This principal is already appointed. Manage it as a supplier from here.",
    };
  }

  if (to === "declined" || to === "dormant") return { ok: true };

  // Reviving a parked or declined prospect: anywhere on the progression is fair, since it resumes
  // wherever the conversation actually left off rather than restarting at the top. `declined` is
  // included so a misclick can be undone — see PRINCIPAL_TERMINAL_STAGES.
  if (from === "dormant" || from === "declined") {
    return PROGRESSION.includes(to as PrincipalStage)
      ? { ok: true }
      : { ok: false, reason: `A ${humanStage(from)} prospect cannot move to ${humanStage(to)}.` };
  }

  const fromIndex = PROGRESSION.indexOf(from as PrincipalStage);
  const toIndex = PROGRESSION.indexOf(to as PrincipalStage);
  if (toIndex === fromIndex + 1) return { ok: true };

  if (toIndex <= fromIndex) {
    return {
      ok: false,
      reason:
        `A prospect does not move backwards. If this has stalled, park it as dormant — ` +
        `that is what the stage is for.`,
    };
  }
  return {
    ok: false,
    reason: `Move to ${humanStage(PROGRESSION[fromIndex + 1]!)} first — stages are not skipped.`,
  };
}

/** The stages a person may move to from here, for building the UI's action list. */
export function principalStagesFrom(stage: string): PrincipalStage[] {
  return PRINCIPAL_STAGES.filter((candidate) => checkPrincipalTransition(stage, candidate).ok);
}

// ---- expiry health -----------------------------------------------------------------------------

/**
 * §5c's two expiry dates, which are the whole reason this is a tracked record rather than a note.
 *
 * "A quotation costed from a lapsed price list is a margin incident waiting to happen" — so a
 * lapsed price list is not a warning, it is the thing module 02 must refuse to cost against. The
 * agreement is the same question one level up: quoting a brand AIES is no longer appointed for.
 */
export const PRINCIPAL_EXPIRY_WARNING_DAYS = 60;

const DAY_MS = 86_400_000;

export type ExpiryState = "none" | "valid" | "expiring" | "expired";

export interface PrincipalHealth {
  agreement: ExpiryState;
  priceList: ExpiryState;
  agreementDaysRemaining: number | null;
  priceListDaysRemaining: number | null;
  /** True when a quotation costed off this principal today would be built on a lapsed price. */
  priceListUnsafeToQuote: boolean;
}

function expiryState(at: Date | null, now: Date): { state: ExpiryState; days: number | null } {
  if (!at) return { state: "none", days: null };
  const days = Math.floor((at.getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return { state: "expired", days };
  if (days <= PRINCIPAL_EXPIRY_WARNING_DAYS) return { state: "expiring", days };
  return { state: "valid", days };
}

export function assessPrincipal(
  record: {
    stage: string;
    agreementExpiresAt: Date | null;
    priceListValidUntil: Date | null;
  },
  now: Date = new Date(),
): PrincipalHealth {
  const agreement = expiryState(record.agreementExpiresAt, now);
  const priceList = expiryState(record.priceListValidUntil, now);

  return {
    agreement: agreement.state,
    priceList: priceList.state,
    agreementDaysRemaining: agreement.days,
    priceListDaysRemaining: priceList.days,
    // Only meaningful once appointed: a prospect nobody has appointed is not being quoted from, so
    // flagging its price list would be noise on every row of the early pipeline.
    priceListUnsafeToQuote: record.stage === "appointed" && priceList.state === "expired",
  };
}
