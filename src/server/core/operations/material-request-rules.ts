/**
 * Material request rules (specs/04-operations-projects.md §7).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §7's first sentence is the one that shapes this file: "The flowchart's Y / N/A / N diamond. **All
 * three outcomes are real**: materials needed, not applicable to this ticket, or needed but not yet
 * available." Two of those are easy to model. The middle one is the one systems usually lose.
 */

export const MATERIAL_REQUEST_ENTITY_TYPE = "MaterialRequest";
export const MATERIAL_REQUEST_DOCUMENT_TYPE = "material_request";
export const STOCK_ITEM_ENTITY_TYPE = "StockItem";

/** §19's three. */
export const MATERIAL_RAISE_PERMISSION = "material_request.raise";
export const MATERIAL_APPROVE_PERMISSION = "material_request.approve";
export const MATERIAL_ISSUE_PERMISSION = "material_request.issue";

/** §7's line types. */
export const ITEM_TYPES = [
  "consumable",
  "spare_part",
  "tool",
  "instrument",
  "ppe",
  "rental",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  consumable: "Consumable",
  spare_part: "Spare part",
  tool: "Tool",
  instrument: "Instrument",
  ppe: "PPE",
  rental: "Rental",
};

/**
 * §7's sources.
 *
 * `purchase` is the one with a consequence outside this module: those lines emit
 * `material.purchase_required` and module 03 raises a purchase request.
 */
export const SOURCES = ["stock", "purchase", "customer_supplied", "rental"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  stock: "From stock",
  purchase: "Needs buying",
  customer_supplied: "Customer supplies",
  rental: "Rented in",
};

/** §7's request statuses. */
export const MATERIAL_REQUEST_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "partially_issued",
  "issued",
  "purchased",
  "rejected",
  "cancelled",
] as const;
export type MaterialRequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];

/**
 * §3's `Ticket.materialRequestStatus` — the gate's own answer, which is not the request's status.
 *
 * `not_applicable` is a value here and that is the whole point. §7: "`N/A` is a legitimate,
 * recorded answer — **not a skipped step**. The record shows someone decided." A ticket that simply
 * has no material request is indistinguishable from one nobody has thought about, and the
 * difference between those two is a crew standing in a store room at seven in the morning.
 */
export const TICKET_MATERIAL_STATES = [
  /**
   * Nobody has been asked yet. The default, since 2026-08-17 — it used to be `not_applicable`,
   * which meant a ticket nobody had looked at claimed a decision had been made.
   */
  "undecided",
  "required",
  "not_applicable",
  "requested",
  "issued",
  "partial",
] as const;
export type TicketMaterialState = (typeof TICKET_MATERIAL_STATES)[number];

export function isMaterialRequestEditable(status: string): boolean {
  return status === "draft";
}

// ---- §1's Gate 2 --------------------------------------------------------------------------------

export type MaterialGateState = "undecided" | "not_required" | "satisfied" | "blocked";

export interface MaterialGate {
  state: MaterialGateState;
  blocks: boolean;
  message: string;
}

/**
 * §7's diamond, as the gate §8 will ask.
 *
 * Four states rather than three, because "nobody has answered the question yet" is different from
 * "the answer was no". §7 insists N/A is recorded rather than skipped; the corollary is that an
 * unanswered ticket must be visibly unanswered, not quietly treated as needing nothing.
 *
 * `undecided` blocks. That is deliberate and it is the whole value of the gate: the failure mode
 * being prevented is a crew mobilising because nobody asked, and a gate that waves through the
 * unanswered case prevents exactly nothing.
 */
export function materialGate(
  ticket: { materialRequestStatus: string },
  requests: readonly { status: string }[],
): MaterialGate {
  if (ticket.materialRequestStatus === "not_applicable") {
    return {
      state: "not_required",
      blocks: false,
      // Somebody answered N/A, and §7 wants that visible as a decision rather than an absence.
      message: "Somebody recorded that this ticket needs no materials. Nothing is holding it up.",
    };
  }

  const live = requests.filter((r) => r.status !== "cancelled" && r.status !== "rejected");

  if (live.some((r) => r.status === "issued")) {
    return {
      state: "satisfied",
      blocks: false,
      message: "The materials have been issued. The crew can mobilise.",
    };
  }

  if (live.length === 0) {
    return {
      state: "undecided",
      blocks: true,
      message:
        "Nobody has answered the materials question for this ticket. Raise a request, or record " +
        "that none are needed — an unanswered question is not the same as a no.",
    };
  }

  const partial = live.find((r) => r.status === "partially_issued");
  if (partial) {
    return {
      state: "blocked",
      blocks: true,
      message:
        "Only part of the materials have been issued. What is missing is what the crew will " +
        "discover on site.",
    };
  }

  const purchased = live.find((r) => r.status === "purchased");
  if (purchased) {
    return {
      state: "blocked",
      blocks: true,
      // §7: "The ticket sits at `material_pending` until resolved."
      message: "Materials are on order. Nothing mobilises until they arrive and are issued.",
    };
  }

  return {
    state: "blocked",
    blocks: true,
    message:
      "The material request has not been issued yet. Mobilisation waits on the store, not on the " +
      "approval.",
  };
}

// ---- §7's calibration block ---------------------------------------------------------------------

export interface CalibrationCheck {
  blocked: boolean;
  message: string;
}

/**
 * §7: "**Drawing an overdue-calibration instrument is blocked.**"
 *
 * Not a warning. Everything else in this build that could be a block is a warning with a reason —
 * photographs on an inspection, a duration on a method statement — and this one is genuinely
 * different: a measurement taken with an out-of-calibration instrument is not a slightly worse
 * measurement, it is a number with no standing. It ends up on a service report a customer keeps, and
 * module 08's out-of-tolerance assessment exists to find every job that used the instrument and
 * revisit them.
 *
 * Letting it out of the store and warning about it means the work happens anyway and the assessment
 * has more to unpick.
 */
export function calibrationCheck(
  item: { name: string; calibrationDueAt: Date | string | null } | null,
  itemType: string,
  now: Date = new Date(),
): CalibrationCheck {
  if (itemType !== "instrument" || !item) return { blocked: false, message: "" };

  if (!item.calibrationDueAt) {
    // Unknown is not the same as fine, and for an instrument it is not good enough to assume.
    return {
      blocked: true,
      message:
        `${item.name} has no calibration due date recorded. An instrument with no calibration ` +
        `record cannot be issued — a measurement from it would have no standing.`,
    };
  }

  const due = new Date(item.calibrationDueAt);
  if (due.getTime() < now.getTime()) {
    return {
      blocked: true,
      message:
        `${item.name} is out of calibration — it was due ${due.toISOString().slice(0, 10)}. ` +
        `Recalibrate it before it goes to site.`,
    };
  }

  return { blocked: false, message: "" };
}

// ---- issuing and returning ----------------------------------------------------------------------

export interface IssueLine {
  lineNo: number;
  quantity: number;
  qtyIssued: number;
}

/** Whether a request is fully issued, partly issued, or untouched. */
export function issueStateOf(lines: readonly IssueLine[]): MaterialRequestStatus {
  if (lines.length === 0) return "approved";
  const anyIssued = lines.some((line) => line.qtyIssued > 0);
  const allIssued = lines.every((line) => line.qtyIssued >= line.quantity);
  if (allIssued) return "issued";
  return anyIssued ? "partially_issued" : "approved";
}

/**
 * How much of a line may still be issued.
 *
 * Over-issue is refused rather than absorbed: the store's count is the only thing standing between
 * the company and tools it cannot find, and a quantity that quietly exceeds what was asked for makes
 * the outstanding-custody list wrong in the direction nobody checks.
 */
export function issuableQuantity(line: { quantity: number; qtyIssued: number }): number {
  return Math.max(0, line.quantity - line.qtyIssued);
}

export interface CustodyLine {
  itemType: string;
  description: string;
  qtyIssued: number;
  qtyReturned: number;
  qtyConsumed: number;
}

/**
 * What is still out (§7's outstanding-custody list).
 *
 * §7: "Unreturned tools appear on an outstanding-custody list per technician. **Tools disappear
 * otherwise; this is universal.**"
 *
 * Consumables are excluded from custody by construction — a tube of sealant that went to site is not
 * coming back and chasing it would train people to ignore the list. What is tracked is the thing
 * that has to come back: tools, instruments and rentals.
 */
export const RETURNABLE_TYPES: readonly string[] = ["tool", "instrument", "rental"];

export function outstandingCustody(lines: readonly CustodyLine[]): CustodyLine[] {
  return lines.filter(
    (line) =>
      RETURNABLE_TYPES.includes(line.itemType) &&
      line.qtyIssued - line.qtyReturned - line.qtyConsumed > 0,
  );
}

export function custodyOutstandingQty(line: CustodyLine): number {
  return Math.max(0, line.qtyIssued - line.qtyReturned - line.qtyConsumed);
}

// ---- §7's fan-out to module 03 ------------------------------------------------------------------

/**
 * The lines module 03 has to buy (§7).
 *
 * §7: "Lines with `source = purchase` emit `material.purchase_required` → module 03 raises a
 * purchase request."
 */
export function purchaseLines<T extends { source: string }>(lines: readonly T[]): T[] {
  return lines.filter((line) => line.source === "purchase");
}

/** Whether anything on this request is waiting on a purchase, which is what holds the ticket. */
export function awaitsPurchase(lines: readonly { source: string; status: string }[]): boolean {
  return lines.some((line) => line.source === "purchase" && line.status !== "issued");
}
