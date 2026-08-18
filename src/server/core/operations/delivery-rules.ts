/**
 * The delivery lane (specs/04-operations-projects.md §13, with module 03 §7's document).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 *
 * §13: "The flowchart's right-hand column. **Delivery tickets never enter the project lane.**"
 *
 * ## The rule the section turns on
 *
 * §13.2 step 5: "**A courier POD is not a signed AIES delivery receipt.**" Everything else here is
 * bookkeeping; that sentence is the one with money attached. The goods are gone, the customer has
 * them, and until a signed DR comes back AIES cannot bill for them. Both modes reach that state and
 * both escalate on the same clock, because the risk is identical however the box travelled.
 */

export const DELIVERY_FLOW_ENTITY_TYPE = "DeliveryTicketFlow";
export const DELIVERY_RECEIPT_ENTITY_TYPE = "DeliveryReceipt";
export const DELIVERY_RECEIPT_DOCUMENT_TYPE = "delivery_receipt";

/** §19: `delivery.execute`. */
export const DELIVERY_EXECUTE_PERMISSION = "delivery.execute";

/** §13: "own vehicle, or courier for bulk and large items". */
export const DELIVERY_MODES = ["own_vehicle", "courier"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  own_vehicle: "Own vehicle",
  courier: "Courier",
};

export const DELIVERY_STATUSES = [
  "dr_requested",
  "dr_issued",
  "mobilized",
  "attempting",
  "in_transit",
  "delivered_unsigned",
  "completed",
  "failed",
  "rescheduled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  dr_requested: "Delivery receipt requested",
  dr_issued: "Delivery receipt issued",
  mobilized: "Crew and vehicle out",
  attempting: "Attempting delivery",
  in_transit: "With the courier",
  delivered_unsigned: "Delivered, not signed for",
  completed: "Completed",
  failed: "Failed",
  rescheduled: "Rescheduled",
};

/**
 * §13.1 step 5's cause codes, as a closed list.
 *
 * §13.3 wants failed attempts counted "by cause and by customer site — repeated failures at one site
 * are a fixable process problem, usually a wrong contact, and nobody currently counts them". Free
 * text cannot be counted: "nobody there" written five ways is five causes and no pattern.
 */
export const ATTEMPT_FAILURE_CAUSES = [
  "contact_unavailable",
  "site_closed",
  "wrong_address",
  "customer_refused",
  "access_denied",
  "incomplete_items",
  "vehicle_problem",
] as const;
export type AttemptFailureCause = (typeof ATTEMPT_FAILURE_CAUSES)[number];

export const ATTEMPT_FAILURE_LABELS: Record<AttemptFailureCause, string> = {
  contact_unavailable: "Contact person unavailable",
  site_closed: "Site closed",
  wrong_address: "Wrong address",
  customer_refused: "Customer refused",
  access_denied: "Access denied",
  incomplete_items: "Incomplete items",
  vehicle_problem: "Vehicle problem",
};

/**
 * Which causes are AIES's own, for §13.3's reporting.
 *
 * Same principle as §8's standby attribution and §11's warranty fault: a report of failed deliveries
 * that does not separate "they were closed" from "we brought the wrong things" tells the company to
 * chase the customer when the fix is at this end.
 */
export const CAUSE_IS_OURS: Record<AttemptFailureCause, boolean> = {
  contact_unavailable: false,
  site_closed: false,
  wrong_address: true,
  customer_refused: false,
  access_denied: false,
  incomplete_items: true,
  vehicle_problem: true,
};

export interface DeliveryAttempt {
  attemptNo: number;
  at: string;
  contactPersonSought?: string | null;
  contactReached: boolean;
  itemDelivered: boolean;
  drSigned: boolean;
  failureReason?: AttemptFailureCause | null;
  photoFileIds?: string[];
  geo?: { lat: number; lng: number } | null;
  notes?: string | null;
}

export function readAttempts(raw: unknown): DeliveryAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is DeliveryAttempt =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as DeliveryAttempt).attemptNo === "number",
  );
}

// ---- §13's gates ---------------------------------------------------------------------------------

export interface DeliveryCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * §13.1 step 2: "**DR issued? — no DR, no mobilization. Blocking.**"
 *
 * The same gate covers booking a courier, and module 03 §7 gives the reason from its side: a DR
 * issued without a ticket to execute it is a document floating around unassigned. So the two halves
 * hold each other up — no DR without a ticket, no movement without a DR.
 */
export function canLeaveForSite(flow: {
  mode: string;
  drIssuedAt: Date | string | null;
}): DeliveryCheck {
  const errors: string[] = [];
  if (!flow.drIssuedAt) {
    errors.push(
      flow.mode === "courier"
        ? "No delivery receipt has been issued, so there is nothing to send with the shipment. §13.2 " +
            "puts the DR in the box; booking without one means the customer has nothing to sign."
        : "No delivery receipt has been issued. §13.1 makes this blocking: a crew that arrives " +
            "without the document has nothing for the customer to sign and the trip is wasted.",
    );
  }
  return { ok: errors.length === 0, errors, warnings: [] };
}

/**
 * Whether a recorded attempt is coherent.
 *
 * The rule worth having: **a failed attempt needs a cause**. §13.3's whole reporting ask rests on it,
 * and an attempt logged with no reason is a wasted trip nobody can learn from.
 */
export function checkAttempt(attempt: {
  itemDelivered: boolean;
  drSigned: boolean;
  failureReason?: string | null;
  contactReached: boolean;
}): DeliveryCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!attempt.itemDelivered && !attempt.failureReason) {
    errors.push(
      "Say why the delivery failed. §13 counts failed attempts by cause, and repeated failures at " +
        "one site are usually a wrong contact — which nobody can see without the reason.",
    );
  }

  if (
    attempt.failureReason &&
    !ATTEMPT_FAILURE_CAUSES.includes(attempt.failureReason as AttemptFailureCause)
  ) {
    errors.push(`"${attempt.failureReason}" is not one of §13's failure causes.`);
  }

  if (attempt.itemDelivered && attempt.failureReason) {
    errors.push("An attempt that delivered the goods cannot also carry a failure cause.");
  }

  /** §13.1 step 6: delivered but unsigned is its own state, and it is worth saying out loud. */
  if (attempt.itemDelivered && !attempt.drSigned) {
    warnings.push(
      "Delivered but not signed for. The goods are with the customer and AIES cannot bill until the " +
        "signed delivery receipt comes back — chase it now rather than at month end.",
    );
  }

  if (!attempt.contactReached && attempt.itemDelivered) {
    warnings.push("Delivered without reaching the named contact. Record who actually received it.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * What an attempt does to the flow's status.
 *
 * The loop §13.1 draws: failed attempts return to `attempting` and the crew tries again; a delivery
 * parks in `delivered_unsigned` until the signed receipt is actually in the system.
 *
 * **An attempt can never produce `completed`, including one where the driver ticked "signed".**
 * That tick is the driver's account of what happened at the gate; the signed receipt is the
 * artefact, and until it has been uploaded AIES has a claim and no document — which is the state
 * that blocks invoicing and the reason §13 has an escalation clock at all. Only
 * `completeDeliveryService`, which requires the file, closes a delivery.
 *
 * This function returned `completed` for a delivered-and-signed attempt until the integration tests
 * ran: the flow closed itself on the driver's word, and the later call carrying the actual signature
 * was then refused as a duplicate. The same distinction §13.2 makes about a courier's POD, missed one
 * layer down. docs/DECISIONS.md #85.
 */
export function statusAfterAttempt(attempt: {
  itemDelivered: boolean;
  drSigned: boolean;
}): DeliveryStatus {
  return attempt.itemDelivered ? "delivered_unsigned" : "attempting";
}

/**
 * §13.2 step 5, as a function, because it is the section's whole point.
 *
 * A courier's proof of delivery records that a box arrived. A signed delivery receipt records that
 * **the customer accepted these goods against this order** — which is what a bill rests on. Treating
 * the first as the second is how a company delivers everything and can invoice none of it.
 */
export function canComplete(flow: {
  mode: string;
  courierPodFileId?: string | null;
  drSignedAt?: Date | string | null;
}): DeliveryCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!flow.drSignedAt) {
    errors.push(
      flow.courierPodFileId
        ? "The courier's proof of delivery is not a signed delivery receipt. §13.2 is explicit: the " +
            "signed DR still has to come back before this ticket can close, chased from the customer " +
            "if the courier did not return it."
        : "Nobody has signed the delivery receipt, so there is nothing to close this against.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * §13's escalation clock for delivered-but-unsigned.
 *
 * Working days rather than calendar, like every other deadline in this module — a Friday delivery
 * should not be overdue on Monday morning. The window is a constant because `SystemSetting` belongs
 * to module 09; the seam is here for when it lands, exactly as §3's SLA did.
 */
export const UNSIGNED_DR_ESCALATION_WORKING_DAYS = 3;

export interface UnsignedStanding {
  overdue: boolean;
  workingDaysWaiting: number;
  message: string;
}

export function unsignedStanding(input: {
  deliveredAt: Date | null;
  workingDaysSince: number;
}): UnsignedStanding {
  if (!input.deliveredAt) {
    return { overdue: false, workingDaysWaiting: 0, message: "Not delivered yet." };
  }

  const overdue = input.workingDaysSince >= UNSIGNED_DR_ESCALATION_WORKING_DAYS;
  return {
    overdue,
    workingDaysWaiting: input.workingDaysSince,
    message: overdue
      ? `Delivered ${input.workingDaysSince} working day(s) ago and still unsigned. This is billable ` +
        `work the company cannot invoice.`
      : `Delivered ${input.workingDaysSince} working day(s) ago, signature outstanding.`,
  };
}

// ---- §13.3's reporting ---------------------------------------------------------------------------

export interface DeliveryFlowSummary {
  mode: DeliveryMode;
  attempts: readonly DeliveryAttempt[];
  siteId?: string | null;
  freightCost?: number | null;
  completed: boolean;
}

/**
 * §13.3: failed attempts by cause and by site, and own-vehicle versus courier.
 *
 * The second half is the one with a decision attached — §13.3 calls it "the data needed to decide
 * when to stop driving".
 */
export function deliveryReport(flows: readonly DeliveryFlowSummary[]) {
  const byCause = new Map<string, number>();
  const bySite = new Map<string, number>();
  let oursCount = 0;
  let failedAttempts = 0;

  const byMode: Record<DeliveryMode, { deliveries: number; completed: number; freight: number }> = {
    own_vehicle: { deliveries: 0, completed: 0, freight: 0 },
    courier: { deliveries: 0, completed: 0, freight: 0 },
  };

  for (const flow of flows) {
    const mode = DELIVERY_MODES.includes(flow.mode) ? flow.mode : "own_vehicle";
    byMode[mode].deliveries += 1;
    if (flow.completed) byMode[mode].completed += 1;
    byMode[mode].freight += flow.freightCost ?? 0;

    for (const attempt of flow.attempts) {
      if (attempt.itemDelivered || !attempt.failureReason) continue;
      failedAttempts += 1;
      byCause.set(attempt.failureReason, (byCause.get(attempt.failureReason) ?? 0) + 1);
      if (CAUSE_IS_OURS[attempt.failureReason]) oursCount += 1;
      const site = flow.siteId ?? "unspecified";
      bySite.set(site, (bySite.get(site) ?? 0) + 1);
    }
  }

  return {
    failedAttempts,
    /** How many failures were AIES's own doing — the half worth acting on first. */
    causedByUs: oursCount,
    causedByUsPct:
      failedAttempts === 0 ? null : Math.round((oursCount / failedAttempts) * 1000) / 10,
    byCause: [...byCause.entries()]
      .map(([cause, count]) => ({
        cause,
        count,
        ours: CAUSE_IS_OURS[cause as AttemptFailureCause],
      }))
      .sort((a, b) => b.count - a.count),
    /** Sites that failed more than once — §13.3's "fixable process problem". */
    repeatFailureSites: [...bySite.entries()]
      .filter(([, count]) => count > 1)
      .map(([siteId, count]) => ({ siteId, count }))
      .sort((a, b) => b.count - a.count),
    byMode,
  };
}
