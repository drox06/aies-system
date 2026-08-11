import {
  addBusinessMs,
  businessMsBetween,
  BUSINESS_DAY_MS,
} from "@/server/core/calendar/business-days";

/**
 * The inquiry lifecycle (specs/01-crm-inquiry.md §3) and its SLA clock.
 *
 * Pure rules — no database, no Prisma — so the UI can import them to decide which buttons to show
 * without pulling Prisma into the browser bundle. Same split as accreditation-rules.ts.
 *
 * §3 draws the lifecycle as a diagram, and a diagram is a claim about which moves are legal. This
 * file is that claim written down. The alternative — letting a `status` string be set to anything —
 * looks equivalent until someone drags a card from `new` straight to `won` and the pipeline report
 * that §1 exists to produce quietly stops meaning anything.
 */

export const INQUIRY_STATUSES = [
  "new",
  "acknowledged",
  "evaluating",
  "inspection_required",
  "quoting",
  "quoted",
  "po_received",
  "won",
  "lost",
  "disqualified",
] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** Nothing moves out of these. */
export const TERMINAL_STATUSES: readonly InquiryStatus[] = ["won", "lost", "disqualified"];

export const INQUIRY_SOURCES = [
  "email",
  "website",
  "linkedin",
  "phone",
  "walk_in",
  "referral",
  "existing_customer",
  "trade_show",
] as const;

export const SERVICE_TYPES = [
  "supply",
  "installation",
  "commissioning",
  "calibration",
  "pm",
  "corrective",
  "inspection",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

/**
 * §5's "required outputs (photos, tag list, measurements)", as a picklist so a report can count
 * them. `other` carries the long tail without turning the field into free text.
 *
 * Here rather than in inspection-service.ts because the request form needs it, and that service
 * reaches Prisma and the numbering service — which reaches `node:crypto`. A client component
 * importing it pulled all of that into the browser bundle and broke the production build outright.
 * That is what this pure-rules split is for.
 */
export const INSPECTION_OUTPUTS = [
  "photos",
  "tag_list",
  "measurements",
  "sketch",
  "nameplate_data",
  "access_notes",
  "other",
] as const;

/**
 * §3: "`lostReason` is a required, configurable picklist. Without enforced loss reasons the
 * pipeline reports are worthless."
 *
 * Configurable eventually means module 09's settings; until that exists this list is the picklist,
 * and it is a picklist rather than free text because free text produces forty spellings of "price"
 * and no report.
 */
export const LOST_REASONS = [
  "price",
  "lead_time",
  "technical_fit",
  "competitor_incumbent",
  "budget_withdrawn",
  "no_response",
  "lost_to_principal_direct",
  "other",
] as const;

export type LostReason = (typeof LOST_REASONS)[number];

interface TransitionDef {
  to: InquiryStatus;
  /**
   * Set by another module reacting to an event, never by a person clicking a button.
   *
   * §3: "`won` / `lost` are set by the quotation outcome, not manually — the inquiry mirrors its
   * quotation." The same applies to `quoted`, which mirrors `quotation.sent`. Module 02 owns all
   * three; until it exists these are unreachable, and that is correct rather than a gap — an
   * inquiry marked won by hand with no quotation behind it is a number nobody can audit.
   */
  systemOnly?: boolean;
  /** §4's completeness gate applies to this move. */
  requiresCompleteRequirements?: boolean;
  /**
   * The move needs a customer purchase order on the record, with its scanned document.
   *
   * The company's rule, in their words: "for this to move to the next column a PO should be
   * uploaded". It is a gate rather than a courtesy because the column *means* the PO arrived — a
   * card sitting in "Received PO" with nothing behind it is the same failure as a quotation marked
   * sent that nobody sent.
   *
   * Enforced in `transitionInquiryService`, which reads the PO, not here: this file stays pure.
   */
  requiresCustomerPo?: boolean;
}

/**
 * §3's diagram, transcribed exactly.
 *
 * Read the omissions as deliberate. `new → disqualified` is not here: the diagram routes
 * disqualification through `evaluating`, so junk still gets acknowledged and looked at before it is
 * thrown away. That is the conservative reading of an ambiguity (Spec.md §11.3) and it is the safer
 * one — the failure this module exists to fix is inquiries disappearing, and a one-click discard on
 * an unread inquiry is exactly how that happens. See docs/DECISIONS.md #20.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<InquiryStatus, readonly TransitionDef[]>> = {
  new: [{ to: "acknowledged" }],
  acknowledged: [{ to: "evaluating" }],
  evaluating: [
    { to: "inspection_required" },
    { to: "quoting", requiresCompleteRequirements: true },
    { to: "disqualified" },
  ],
  inspection_required: [{ to: "evaluating" }],
  quoting: [{ to: "quoted", systemOnly: true }],
  quoted: [
    { to: "po_received", requiresCustomerPo: true },
    { to: "won", systemOnly: true },
    { to: "lost", systemOnly: true },
  ],
  // A received PO is not yet a won deal — the work still has to be delivered, and modules 03 and 04
  // own that. So `won` stays system-set, and this column is where a deal sits while it is being
  // turned into an order.
  po_received: [{ to: "won", systemOnly: true }],
  won: [],
  lost: [],
  disqualified: [],
};

export interface TransitionCheck {
  ok: boolean;
  /** Why not, phrased for the person who tried. */
  reason?: string;
  definition?: TransitionDef;
}

/**
 * The company's word for each status, where it differs from the stored key.
 *
 * Two entries, both asked for by name.
 *
 * **`quoted` reads as "Sent".** They are the same fact — §3 sets `quoted` from `quotation.sent`, so
 * an inquiry is `quoted` precisely when its quotation went to the customer. But on a board next to a
 * column called "Quoting", the word "Quoted" reads as *we have written a quotation*, which is what
 * the previous column already means. "Sent" says the thing that actually changed. The key stays
 * `quoted` because that is §3's vocabulary and what every report and audit row already contains;
 * only the label moves.
 *
 * **`po_received` reads as "Received PO"**, which is how the company says it.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  quoted: "Sent",
  po_received: "Received PO",
};

export function humanStatus(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

/**
 * Whether a status change is legal.
 *
 * `bySystem` distinguishes a module reacting to an event from a user pressing a button. It defaults
 * to false so that forgetting to pass it fails closed.
 */
export function checkTransition(
  from: string,
  to: string,
  options: { bySystem?: boolean } = {},
): TransitionCheck {
  if (from === to) {
    return { ok: false, reason: `This inquiry is already ${humanStatus(to)}.` };
  }
  if (!INQUIRY_STATUSES.includes(to as InquiryStatus)) {
    return { ok: false, reason: `"${to}" is not an inquiry status.` };
  }

  const allowed = ALLOWED_TRANSITIONS[from as InquiryStatus];
  if (!allowed) {
    return { ok: false, reason: `"${from}" is not an inquiry status.` };
  }

  const definition = allowed.find((t) => t.to === to);
  if (!definition) {
    if (TERMINAL_STATUSES.includes(from as InquiryStatus)) {
      return {
        ok: false,
        reason:
          `This inquiry is ${humanStatus(from)} and cannot be reopened. ` +
          `Log a new inquiry instead.`,
      };
    }
    const destinations = allowed.map((t) => humanStatus(t.to)).join(", ") || "nothing";
    return {
      ok: false,
      reason: `An inquiry that is ${humanStatus(from)} can only move to: ${destinations}.`,
    };
  }

  if (definition.systemOnly && !options.bySystem) {
    return {
      ok: false,
      reason:
        `${humanStatus(to)} is set by the quotation's own outcome, not by hand — ` +
        `it follows the quotation this inquiry is linked to.`,
    };
  }

  return { ok: true, definition };
}

/** The transitions a person may make from here, for building the UI's action list. */
export function userTransitionsFrom(status: string): InquiryStatus[] {
  const allowed = ALLOWED_TRANSITIONS[status as InquiryStatus] ?? [];
  return allowed.filter((t) => !t.systemOnly).map((t) => t.to);
}

// ---- SLA (§3, §5) ------------------------------------------------------------------------------

/**
 * §3: "`new → acknowledged` must happen within an SLA (default 1 business day, configurable)."
 *
 * Configurable means module 09's system settings, which do not exist. One constant, in one place,
 * is the honest version of "not configurable yet" — a default read from a settings table that has
 * no rows would only look configurable.
 */
export const INQUIRY_ACK_SLA_BUSINESS_DAYS = 1;

export interface SlaInput {
  status: string;
  receivedAt: Date;
  acknowledgedAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedMs: number;
}

export interface SlaAssessment {
  /** When acknowledgement is (or was) due, with paused time added back on. */
  dueAt: Date;
  /** Working time consumed so far, excluding pauses. */
  consumedMs: number;
  /** Working time left. Negative once the deadline has passed. */
  remainingMs: number;
  /** True if the deadline passed before acknowledgement — including a late acknowledgement. */
  breached: boolean;
  /** Breached *and* still unacknowledged: what the nightly sweep chases. */
  escalatable: boolean;
  paused: boolean;
}

/**
 * Derives the acknowledgement SLA. Nothing is stored — the deadline is a function of `receivedAt`,
 * the working calendar, and how long the clock has been paused.
 *
 * Same reasoning as the accreditation status: a stored `slaDueAt` is a second copy of a derived
 * fact, and it goes wrong the first time someone corrects a backdated `receivedAt` or the SLA
 * setting changes. Nothing runs before a page is opened, so the read has to answer for itself.
 */
export function assessInquirySla(record: SlaInput, now: Date = new Date()): SlaAssessment {
  const paused = record.slaPausedAt !== null && record.acknowledgedAt === null;

  // A clock that is still paused keeps accruing paused time up to now (or to the acknowledgement,
  // if one arrived while it was paused).
  const pausedMs =
    record.slaPausedMs +
    (record.slaPausedAt ? businessMsBetween(record.slaPausedAt, record.acknowledgedAt ?? now) : 0);

  // Measured to the acknowledgement, not to now: acknowledging late is a breach that happened, and
  // it should not keep getting worse afterwards.
  const measuredTo = record.acknowledgedAt ?? now;
  const consumedMs = Math.max(0, businessMsBetween(record.receivedAt, measuredTo) - pausedMs);

  const budgetMs = INQUIRY_ACK_SLA_BUSINESS_DAYS * BUSINESS_DAY_MS;
  const dueAt = addBusinessMs(record.receivedAt, budgetMs + pausedMs);
  const breached = consumedMs > budgetMs;

  return {
    dueAt,
    consumedMs,
    remainingMs: budgetMs - consumedMs,
    breached,
    // §5's pause, enforced a second time here. With §3's transition map an unacknowledged inquiry
    // cannot reach `inspection_required`, so this arm is belt-and-braces today — but it means the
    // pause survives any future loosening of the map, and §10 asks for the behaviour by name.
    escalatable:
      breached && record.acknowledgedAt === null && record.status !== "inspection_required",
    paused,
  };
}

/**
 * Who may acknowledge an inquiry.
 *
 * The company's rule: an inquiry is logged *for* a named salesperson, and the process continues when
 * **that person** picks it up. Acknowledgement is the moment somebody accepts the work — it stops
 * §3's SLA clock and puts their name against it — so letting anyone click it would make the clock
 * measure nothing.
 *
 * A manager holding `inquiry.assign` may still acknowledge on someone's behalf. Somebody is on leave
 * and the customer is waiting; reassignment is the tidy route, but the audit row records who
 * actually clicked either way, which is the part that matters.
 *
 * Lives here, in the pure lifecycle file, because the record page uses it to explain a disabled
 * button and the service uses it to refuse the mutation. One rule, both ends.
 */
export function canAcknowledge(
  user: { id: string; permissions: ReadonlySet<string> | readonly string[] },
  inquiry: { ownerId: string },
): boolean {
  if (user.id === inquiry.ownerId) return true;
  return Array.isArray(user.permissions)
    ? user.permissions.includes("inquiry.assign")
    : (user.permissions as ReadonlySet<string>).has("inquiry.assign");
}
