/**
 * Supplier PO rules (specs/03-order-procurement.md §4 and §5).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs, same split as po-verification.ts and costing.ts.
 *
 * Three things live here: the status vocabulary, §4's downpayment gate, and §5's landed-cost
 * allocation. The gate and the allocation are both cases where a wrong answer is expensive and
 * invisible — one lets AIES commit money the customer has not paid, the other makes reported margin
 * fiction — and both are far easier to test as functions than as behaviours of a service.
 */

export const SUPPLIER_PO_ENTITY_TYPE = "SupplierPO";
export const SUPPLIER_PO_DOCUMENT_TYPE = "supplier_po";

/** §10's permission for stepping past the downpayment gate. */
export const DOWNPAYMENT_OVERRIDE_PERMISSION = "procurement.override_downpayment_gate";
/** Buying from a vendor clause 8.4 has not approved is the officers' call, like the appointment. */
export const UNAPPROVED_SUPPLIER_OVERRIDE_PERMISSION = "supplier.approve";

/**
 * §2's vocabulary, in the order a PO moves through it.
 *
 * `partially_received` and `received` are moved by session 3's goods receipt and are listed here
 * anyway — the same reason `CustomerPO.status` carried `verified` before anything could set it: a
 * column with its full vocabulary lets the next session add behaviour without a migration.
 */
export const SUPPLIER_PO_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "acknowledged",
  "partially_received",
  "received",
  "cancelled",
] as const;

export type SupplierPOStatus = (typeof SUPPLIER_PO_STATUSES)[number];

/** Statuses where the document still counts as an open commitment for the expediting view. */
export const OPEN_SUPPLIER_PO_STATUSES: readonly SupplierPOStatus[] = [
  "approved",
  "sent",
  "acknowledged",
  "partially_received",
];

/**
 * Whether the lines and header charges can still be edited.
 *
 * Once a PO has been approved, editing it silently changes what the VP agreed to. §5 routes changes
 * back through the approval instead, which is why this closes at `approved` and not at `sent`.
 */
export function isSupplierPoEditable(status: string): boolean {
  return status === "draft";
}

// ---- §4's downpayment gate ----------------------------------------------------------------------

/**
 * The settings flag §4 names, with the default §4 gives it.
 *
 * A constant rather than a settings row, because module 09 owns settings and does not exist. It is
 * named and exported so the day module 09 lands is a one-line change with one call site, and so the
 * flag is greppable now rather than being an unlabelled `true` inside a condition.
 */
export const BLOCK_PROCUREMENT_UNTIL_DOWNPAYMENT = true;

export type DownpaymentGateState = "not_required" | "satisfied" | "blocked";

export interface DownpaymentGate {
  state: DownpaymentGateState;
  /** True when the PO may not leave draft without an override. */
  blocks: boolean;
  /** Shown on the sales order header — §4: "so nobody has to ask finance in a chat app". */
  message: string;
}

/**
 * §4: "the supplier PO cannot leave `draft` until module 05 emits `payment.received` covering the
 * downpayment."
 *
 * Reads `financeStatus` rather than a payment record, because module 05 owns payments and this
 * module owns the workstream column that module 05 will move. That keeps the dependency running
 * downward — module 03 never reaches into module 05 — and it means the gate is already correct on
 * the day payments arrive, with no second mechanism to reconcile.
 *
 * **Today the gate is inert**, and honestly so: `PaymentTerm` is module 05's, so every sales order
 * is created with `downpaymentPct = 0` and `financeStatus = "not_required"`. That is not the gate
 * failing — it is the gate correctly reporting that nobody has asked for a downpayment. The
 * blocking path is reachable the moment a term with a downpayment exists, and is tested by setting
 * the column directly.
 */
export function downpaymentGate(order: {
  financeStatus: string;
  downpaymentPct: number;
  currency: string;
  downpaymentAmount: number;
}): DownpaymentGate {
  if (!BLOCK_PROCUREMENT_UNTIL_DOWNPAYMENT) {
    return {
      state: "satisfied",
      blocks: false,
      message: "Procurement is not gated on the downpayment in this configuration.",
    };
  }

  if (order.downpaymentPct <= 0 || order.financeStatus === "not_required") {
    return {
      state: "not_required",
      blocks: false,
      message: "No downpayment was agreed, so procurement is not waiting on finance.",
    };
  }

  if (order.financeStatus === "awaiting_downpayment") {
    return {
      state: "blocked",
      blocks: true,
      message:
        `Waiting on a ${(order.downpaymentPct * 100).toFixed(0)}% downpayment of ` +
        `${order.currency} ${order.downpaymentAmount.toFixed(2)}. Supplier POs stay in draft until ` +
        `finance records it — or until the President or Vice President overrides, with a reason.`,
    };
  }

  // downpayment_received, partially_billed, fully_billed, paid — money has arrived.
  return {
    state: "satisfied",
    blocks: false,
    message: "The downpayment is in. Procurement is clear to order.",
  };
}

// ---- clause 8.4 ---------------------------------------------------------------------------------

export interface SupplierApprovalGate {
  blocks: boolean;
  message: string;
}

/**
 * ISO 9001 clause 8.4: whether AIES may place an order with this supplier.
 *
 * Session 1 built the approval and deliberately left it gating nothing — "recording what an
 * unapproved supplier quoted is useful; *ordering* from one is the thing clause 8.4 governs, and
 * that gate belongs on the supplier PO where it can be overridden with a reason by somebody
 * accountable." This is that gate.
 *
 * Overridable rather than absolute, for the same reason §4's is: the urgent single-source purchase
 * at 4pm on a Friday happens, and a system that cannot represent it is a system people work around.
 * What it must not be is silent.
 */
export function supplierApprovalGate(supplier: {
  name: string;
  isApproved: boolean;
  approvalExpiry: Date | string | null;
}): SupplierApprovalGate {
  if (!supplier.isApproved) {
    return {
      blocks: true,
      message:
        `${supplier.name} is not an approved supplier under ISO 9001 clause 8.4. Approve them on ` +
        `the supplier record, or override here with a reason — the reason is what an auditor reads.`,
    };
  }

  if (supplier.approvalExpiry && new Date(supplier.approvalExpiry).getTime() < Date.now()) {
    return {
      blocks: true,
      message:
        `${supplier.name}'s clause 8.4 approval expired on ` +
        `${new Date(supplier.approvalExpiry).toISOString().slice(0, 10)}. Renew it on the supplier ` +
        `record, or override here with a reason.`,
    };
  }

  return { blocks: false, message: "" };
}

// ---- §5's landed cost ---------------------------------------------------------------------------

export interface LandedCostLine {
  lineNo: number;
  /** quantity × unitCost, in the PO's currency. */
  lineTotal: number;
}

export interface LandedCostAllocation {
  lineNo: number;
  /** The share of freight + duties + other charges this line carries. */
  allocatedCharges: number;
  /** lineTotal + allocatedCharges. This is the number module 09's margin report must use. */
  landedTotal: number;
}

/**
 * Spreads the header charges across the lines by value (§5).
 *
 * §5: "freight, duties, brokerage, and bank charges are captured on the PO header and allocated
 * across lines by value or by weight. Landed cost feeds the true project margin in module 09.
 * **Without this, reported margin is fiction on imported goods.**" By value only for now — weight is
 * not captured on any line, and inventing a weight column that nobody fills would give module 09 a
 * second allocation basis that is always empty.
 *
 * ## The rounding, which is the whole difficulty
 *
 * §11 asks that allocation "sums exactly to the total charge (no rounding leakage)". Allocating
 * ₱1,000 of freight across three equal lines gives 333.33 three times and loses a centavo — and a
 * centavo lost per shipment is a margin report that never quite reconciles, which is worse than a
 * visible error because nobody can find it.
 *
 * So the shares are rounded down to centavos and **the remainder is given to the largest line**,
 * which both makes the sum exact and puts the residue where it is proportionally smallest. The
 * largest line is chosen by value with the lowest line number breaking ties, so the result is
 * deterministic — two runs over the same PO must not differ.
 *
 * Everything here is in **centavos as integers**, which is the same rule the rest of the build
 * follows: floats cannot represent 0.1, and a margin computed through one is wrong by an amount
 * nobody can predict.
 */
export function allocateLandedCost(
  lines: readonly LandedCostLine[],
  charges: { freight?: number; duties?: number; otherCharges?: number },
): LandedCostAllocation[] {
  const toCentavos = (value: number) => Math.round(value * 100);

  const totalCharges =
    toCentavos(charges.freight ?? 0) +
    toCentavos(charges.duties ?? 0) +
    toCentavos(charges.otherCharges ?? 0);

  const lineCentavos = lines.map((line) => toCentavos(line.lineTotal));
  const base = lineCentavos.reduce((sum, value) => sum + value, 0);

  if (lines.length === 0) return [];

  // A PO of zero-value lines with real freight on it: there is no value to allocate by, so the
  // charges are spread evenly. Rare, and returning nothing would hide the charge entirely.
  const weights = base > 0 ? lineCentavos : lines.map(() => 1);
  const weightTotal = base > 0 ? base : lines.length;

  const allocated = weights.map((weight) => Math.floor((totalCharges * weight) / weightTotal));
  const remainder = totalCharges - allocated.reduce((sum, value) => sum + value, 0);

  if (remainder !== 0) {
    let largest = 0;
    for (let i = 1; i < weights.length; i++) {
      // Strictly greater, so the lowest line number wins a tie and the result is deterministic.
      if (weights[i]! > weights[largest]!) largest = i;
    }
    allocated[largest] = allocated[largest]! + remainder;
  }

  return lines.map((line, index) => ({
    lineNo: line.lineNo,
    allocatedCharges: allocated[index]! / 100,
    landedTotal: (lineCentavos[index]! + allocated[index]!) / 100,
  }));
}

/** subtotal + freight + duties + other charges, in centavos so the sum is exact. */
export function supplierPoTotal(input: {
  subtotal: number;
  freight?: number;
  duties?: number;
  otherCharges?: number;
}): number {
  const c = (value: number) => Math.round(value * 100);
  return (
    (c(input.subtotal) +
      c(input.freight ?? 0) +
      c(input.duties ?? 0) +
      c(input.otherCharges ?? 0)) /
    100
  );
}

// ---- the expediting view ------------------------------------------------------------------------

/**
 * How late a shipment is, in whole days, against what it promised.
 *
 * Negative means it is still ahead of its date. Null when no arrival date was ever given, which is
 * different from "on time" and must not be reported as it — an undated PO is the one nobody is
 * chasing, and §5's expediting view exists precisely to surface those.
 */
export function daysLate(
  expectedArrivalDate: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!expectedArrivalDate) return null;
  const due = new Date(expectedArrivalDate);
  const DAY_MS = 86_400_000;
  // Both floored to midnight UTC: a PO due today is not "0.4 days late" at lunchtime.
  const dueDay = Math.floor(due.getTime() / DAY_MS);
  const nowDay = Math.floor(now.getTime() / DAY_MS);
  return nowDay - dueDay;
}
