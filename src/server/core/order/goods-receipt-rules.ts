/**
 * Goods receipt rules (specs/03-order-procurement.md §6 and §11).
 *
 * Pure — no Prisma — so the receiving screen refuses exactly what the server refuses, and so the
 * arithmetic §11 names can be tested without a database. On `UI_SAFE_SERVER_MODULES` in
 * eslint.config.mjs, same split as po-verification.ts and supplier-po-rules.ts.
 *
 * §11's case, in full: "Partial receipt then partial delivery keeps `qtyOrdered/Received/Delivered`
 * consistent; **over-receipt and over-delivery are rejected**."
 */

export const GOODS_RECEIPT_ENTITY_TYPE = "GoodsReceipt";
export const GOODS_RECEIPT_DOCUMENT_TYPE = "goods_receipt";

export const GOODS_RECEIPT_CREATE_PERMISSION = "goods_receipt.create";
export const GOODS_RECEIPT_INSPECT_PERMISSION = "goods_receipt.inspect";

/**
 * Quantities carry three decimals — part-drums of cable, litres of oil — so the tolerance for
 * "the same number" is a thousandth. Same constant as po-verification.ts, and for the same reason:
 * a check that fired on the seventh decimal place would cry wolf on every delivery.
 */
export const QUANTITY_EPSILON = 0.0005;

export const GOODS_RECEIPT_STATUSES = [
  "draft",
  "inspected",
  "accepted",
  "partially_rejected",
  "rejected",
] as const;

export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

// ---- §6's incoming inspection -------------------------------------------------------------------

export interface InspectionChecks {
  quantityChecked: boolean;
  damageChecked: boolean;
  documentationChecked: boolean;
  photosAttached: boolean;
}

export interface InspectionGate {
  complete: boolean;
  /** The checks still outstanding, in the words §6 uses for them. */
  missing: string[];
  message: string;
}

/**
 * ISO 9001 clause 8.4.2, as a gate rather than as a note.
 *
 * §6: "**Incoming inspection is required**… quantity check, damage check, documentation check (test
 * certificates, calibration certificates, datasheets, warranty), and photos."
 *
 * All four, and no partial credit. The temptation is to let three out of four through with a
 * warning, and it should be resisted: an inspection that can be *mostly* done is one that is mostly
 * not done, and the clause's whole value is that "we checked" means something specific. The four are
 * separate because they fail for different reasons — the count can be right while the calibration
 * certificate is missing — and those are two different conversations with the supplier.
 *
 * **Photos are not optional here**, unlike almost everywhere else in this build. They are the only
 * part of the inspection that survives the person who did it: a damaged crate nobody photographed is
 * a dispute AIES loses.
 */
export function inspectionGate(checks: InspectionChecks): InspectionGate {
  const missing: string[] = [];
  if (!checks.quantityChecked) missing.push("quantity check");
  if (!checks.damageChecked) missing.push("damage check");
  if (!checks.documentationChecked) missing.push("documentation check");
  if (!checks.photosAttached) missing.push("photographs");

  if (missing.length === 0) {
    return { complete: true, missing, message: "Incoming inspection complete." };
  }

  return {
    complete: false,
    missing,
    message:
      `Incoming inspection is not finished: ${missing.join(", ")} outstanding. ISO 9001 clause ` +
      `8.4.2 requires all four before these goods can be accepted — "we always check" is not ` +
      `evidence anybody can produce two years later.`,
  };
}

// ---- §11's arithmetic ---------------------------------------------------------------------------

export interface ReceiptLineInput {
  supplierPOLineId: string;
  /** For the message, so a refusal names the item rather than an id. */
  description: string;
  /** What the supplier PO says was ordered. */
  qtyOrdered: number;
  /** What earlier receipts against this PO line already booked in. */
  qtyAlreadyReceived: number;
  qtyReceived: number;
  qtyAccepted: number;
  qtyRejected: number;
}

export interface ReceiptCheckProblem {
  supplierPOLineId: string;
  message: string;
}

export interface ReceiptCheckResult {
  ok: boolean;
  problems: ReceiptCheckProblem[];
}

/**
 * Refuses a receipt that does not add up (§11).
 *
 * Three separate ways a receipt can be wrong, and each gets its own message because each is a
 * different mistake:
 *
 * 1. **Accepted + rejected ≠ received.** A typo, almost always, and one that would otherwise leave
 *    a quantity that arrived and is neither in stock nor going back.
 * 2. **Over-receipt** — more delivered than was ever ordered. §11 names this outright. It is not
 *    always the supplier's error: it is often a receipt entered twice, which is worse, because the
 *    second one silently doubles what the customer's order thinks it has.
 * 3. **Negative quantities**, which are a data-entry slip rather than a business event. A return
 *    goes back through the rejection path, not through a negative receipt.
 *
 * Reports every problem rather than the first, so somebody correcting a ten-line delivery note is
 * told everything at once.
 */
export function checkReceiptLines(lines: readonly ReceiptLineInput[]): ReceiptCheckResult {
  const problems: ReceiptCheckProblem[] = [];

  for (const line of lines) {
    if (line.qtyReceived < 0 || line.qtyAccepted < 0 || line.qtyRejected < 0) {
      problems.push({
        supplierPOLineId: line.supplierPOLineId,
        message: `${line.description}: a quantity cannot be negative. Send goods back through the rejected column, not as a negative receipt.`,
      });
      continue;
    }

    const split = line.qtyAccepted + line.qtyRejected;
    if (Math.abs(split - line.qtyReceived) > QUANTITY_EPSILON) {
      problems.push({
        supplierPOLineId: line.supplierPOLineId,
        message:
          `${line.description}: ${line.qtyReceived} arrived but ${line.qtyAccepted} accepted plus ` +
          `${line.qtyRejected} rejected is ${split}. Everything that came off the truck is one or ` +
          `the other.`,
      });
    }

    const wouldTotal = line.qtyAlreadyReceived + line.qtyReceived;
    if (wouldTotal - line.qtyOrdered > QUANTITY_EPSILON) {
      const remaining = line.qtyOrdered - line.qtyAlreadyReceived;
      problems.push({
        supplierPOLineId: line.supplierPOLineId,
        message:
          `${line.description}: ${line.qtyOrdered} were ordered and ${line.qtyAlreadyReceived} ` +
          `already received, so at most ${remaining} can still be booked in — not ` +
          `${line.qtyReceived}. If the supplier really over-shipped, raise a PO line for the extra ` +
          `so there is an order behind it. If this delivery was already entered, do not enter it ` +
          `twice.`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---- what a receipt and its PO become -----------------------------------------------------------

/**
 * The receipt's own status, from what was accepted and rejected.
 *
 * `partially_rejected` is a real and common outcome — nineteen good meters and one dented — and it
 * must not collapse into either `accepted` or `rejected`, because the accepted nineteen advance the
 * customer's order and the dented one starts a conversation with the supplier.
 */
export function receiptStatusFrom(
  lines: readonly { qtyAccepted: number; qtyRejected: number }[],
): GoodsReceiptStatus {
  const accepted = lines.reduce((sum, line) => sum + line.qtyAccepted, 0);
  const rejected = lines.reduce((sum, line) => sum + line.qtyRejected, 0);

  if (rejected <= QUANTITY_EPSILON) return "accepted";
  if (accepted <= QUANTITY_EPSILON) return "rejected";
  return "partially_rejected";
}

/**
 * The supplier PO's status, from how much of it has arrived.
 *
 * Derived from the lines rather than moved by hand, because a PO whose status disagrees with its
 * own quantities is the sort of thing nobody notices until procurement chases a delivery that is
 * already in the warehouse.
 *
 * Only **accepted** quantities count. Goods that arrived and were rejected are going back; treating
 * them as received would close a PO that is still owed.
 */
export function supplierPoStatusFromReceipts(
  lines: readonly { quantity: number; qtyReceived: number }[],
  currentStatus: string,
): string {
  if (lines.length === 0) return currentStatus;

  const anyReceived = lines.some((line) => line.qtyReceived > QUANTITY_EPSILON);
  const allReceived = lines.every((line) => line.qtyReceived - line.quantity >= -QUANTITY_EPSILON);

  if (allReceived) return "received";
  if (anyReceived) return "partially_received";
  return currentStatus;
}

/**
 * The sales order's procurement workstream (§1), from every supplier PO behind it.
 *
 * One of §1's three independent columns, and it moves on procurement's evidence alone — never on
 * finance's or operations'. A sales order with nothing to buy stays `not_required` rather than
 * being called `received`, because "we received everything" and "there was nothing to receive" are
 * different facts and the second one should not read as progress.
 */
export function procurementStatusFrom(
  supplierPoStatuses: readonly string[],
): "not_required" | "pending" | "ordered" | "partially_received" | "received" {
  const live = supplierPoStatuses.filter((status) => status !== "cancelled");
  if (live.length === 0) return "not_required";

  if (live.every((status) => status === "received")) return "received";
  if (live.some((status) => status === "received" || status === "partially_received")) {
    return "partially_received";
  }
  if (live.some((status) => ["sent", "acknowledged", "approved"].includes(status)))
    return "ordered";
  return "pending";
}
