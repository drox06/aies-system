/**
 * §3's three-way check: the customer's purchase order against the quotation it answers.
 *
 * The spec singles this one function out, and it is worth quoting in full because it sets the bar:
 *
 * > System runs a **three-way check** against the source quotation: PO amount vs quotation total,
 * > PO line quantities vs quotation lines, and delivery/payment terms. Discrepancies are surfaced on
 * > screen and must be resolved (accept, or raise a quotation revision) before the sales order is
 * > created. **This single check prevents the most expensive category of error in this business.**
 *
 * The expensive error is not arithmetic. It is a customer ordering four units against a quotation
 * for five, or ordering at last quarter's price, and nobody noticing until the goods are bought,
 * shipped and installed — at which point AIES is holding stock it cannot bill for, or has committed
 * to a margin it never agreed. Catching it takes thirty seconds at PO receipt and is unrecoverable
 * afterwards.
 *
 * Pure — no Prisma — so the screen can show the same findings the server enforces, and so this is
 * testable without a database. Same split as inquiry-lifecycle.ts and costing.ts, enforced by the
 * `no-restricted-imports` rule in eslint.config.mjs.
 */

/**
 * A centavo. Money is compared in integers of the smallest unit, never as floats — the same rule
 * the whole build follows, and the reason a 43,999.999999 never reads as a mismatch against 44,000.
 */
const MONEY_EPSILON = 0.005;

/** Quantities carry three decimals (part-units of cable, litres), so the tolerance is smaller. */
const QUANTITY_EPSILON = 0.0005;

export type DiscrepancyKind = "amount" | "currency" | "quantity" | "missing_line" | "extra_line";

export type DiscrepancySeverity = "blocking" | "advisory";

export interface Discrepancy {
  kind: DiscrepancyKind;
  /**
   * `blocking` findings stop a sales order until somebody resolves them; `advisory` ones are shown
   * and do not. The split is about who can decide: a currency mismatch is arithmetic nobody can
   * wave through, while a customer ordering fewer units than quoted is a real and ordinary
   * commercial decision that the person recording the PO is entitled to accept.
   */
  severity: DiscrepancySeverity;
  /** The quotation line this concerns, when it concerns one. */
  lineNo?: number;
  message: string;
}

export interface PoCheckLine {
  lineNo: number;
  description: string;
  quantity: number;
}

export interface PoCheckInput {
  quotation: {
    number: string;
    total: number;
    currency: string;
    lines: PoCheckLine[];
  };
  po: {
    poNumber: string;
    amount: number;
    currency: string;
    /**
     * The line quantities as printed on the customer's document, typed by whoever recorded it.
     *
     * Optional, and its absence is **reported rather than assumed away** — see `quantitiesChecked`.
     * `CustomerPO` has no line model (§2 does not give it one), so there is nowhere for these to
     * come from except a person reading the PDF. A check that silently passed when nobody typed
     * them would be worse than no check: it would say "verified" about something it never looked
     * at.
     */
    lines?: PoCheckLine[];
  };
}

export interface PoCheckResult {
  discrepancies: Discrepancy[];
  /** True when nothing blocking was found — the gate `createSalesOrderFromPo` reads. */
  ok: boolean;
  /** False when no PO lines were supplied, so the caller can say the quantity check did not run. */
  quantitiesChecked: boolean;
}

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * Compares the two documents and reports every difference it can see.
 *
 * Reports **all** findings rather than returning on the first: somebody resolving these wants the
 * whole list in front of them, and a check that reveals one problem at a time turns a single
 * conversation with the customer into three.
 */
export function checkCustomerPoAgainstQuotation(input: PoCheckInput): PoCheckResult {
  const discrepancies: Discrepancy[] = [];
  const { quotation, po } = input;

  // ---- currency ---------------------------------------------------------------------------------
  // First, because every other comparison is meaningless across currencies: 44,000 USD against
  // 44,000 PHP is not a rounding difference, and reporting it as an amount mismatch would send
  // somebody looking for the wrong thing.
  if (po.currency !== quotation.currency) {
    discrepancies.push({
      kind: "currency",
      severity: "blocking",
      message:
        `The purchase order is in ${po.currency} and ${quotation.number} was quoted in ` +
        `${quotation.currency}. Nothing else on this page has been compared — fix the currency ` +
        `first, or raise a revision in the currency the customer is buying in.`,
    });
    return { discrepancies, ok: false, quantitiesChecked: false };
  }

  // ---- amount -----------------------------------------------------------------------------------
  const difference = po.amount - quotation.total;
  if (Math.abs(difference) > MONEY_EPSILON) {
    const shortfall = difference < 0;
    discrepancies.push({
      kind: "amount",
      // Advisory, not blocking, and deliberately: a customer ordering part of a quotation is
      // ordinary, and so is one who negotiated after the document went out. What must not happen is
      // nobody *seeing* it — which is what this whole function is for.
      severity: "advisory",
      message:
        `The purchase order is for ${po.currency} ${money(po.amount)}; ${quotation.number} totals ` +
        `${quotation.currency} ${money(quotation.total)} — ` +
        `${shortfall ? "short by" : "over by"} ${money(Math.abs(difference))}. ` +
        `Accept it if the customer ordered part of the scope, or raise a revision so the document ` +
        `and the order agree.`,
    });
  }

  // ---- quantities -------------------------------------------------------------------------------
  const poLines = po.lines;
  if (!poLines || poLines.length === 0) {
    return {
      discrepancies,
      ok: !discrepancies.some((d) => d.severity === "blocking"),
      quantitiesChecked: false,
    };
  }

  const poByLineNo = new Map(poLines.map((line) => [line.lineNo, line]));

  for (const quoted of quotation.lines) {
    const ordered = poByLineNo.get(quoted.lineNo);
    if (!ordered) {
      discrepancies.push({
        kind: "missing_line",
        severity: "advisory",
        lineNo: quoted.lineNo,
        message:
          `Line ${quoted.lineNo} — ${quoted.description} — is on the quotation and not on the ` +
          `purchase order. The customer has not ordered it.`,
      });
      continue;
    }

    const gap = ordered.quantity - quoted.quantity;
    if (Math.abs(gap) > QUANTITY_EPSILON) {
      discrepancies.push({
        kind: "quantity",
        severity: "advisory",
        lineNo: quoted.lineNo,
        message:
          `Line ${quoted.lineNo} — ${quoted.description}: quoted ${quoted.quantity}, ordered ` +
          `${ordered.quantity}. ${
            gap > 0
              ? "More than was quoted, so the price per unit may no longer hold."
              : "Fewer than were quoted."
          }`,
      });
    }
  }

  for (const ordered of poLines) {
    if (!quotation.lines.some((line) => line.lineNo === ordered.lineNo)) {
      discrepancies.push({
        kind: "extra_line",
        // The one line-level finding that blocks. An item on the order that was never quoted has no
        // agreed price and no costed supply — proceeding means committing to deliver something
        // nobody has priced, which is the expensive error §3 exists to prevent.
        severity: "blocking",
        lineNo: ordered.lineNo,
        message:
          `Line ${ordered.lineNo} — ${ordered.description} — is on the purchase order and not on ` +
          `${quotation.number}. It has no agreed price. Raise a revision that includes it before ` +
          `taking the order.`,
      });
    }
  }

  return {
    discrepancies,
    ok: !discrepancies.some((d) => d.severity === "blocking"),
    quantitiesChecked: true,
  };
}

/** A one-line summary for the audit trail and the screen's heading. */
export function summariseCheck(result: PoCheckResult): string {
  if (result.discrepancies.length === 0) {
    return result.quantitiesChecked
      ? "Matches the quotation on amount, currency and every line."
      : "Matches the quotation on amount and currency. Line quantities were not captured.";
  }
  const blocking = result.discrepancies.filter((d) => d.severity === "blocking").length;
  const advisory = result.discrepancies.length - blocking;
  const parts: string[] = [];
  if (blocking > 0) parts.push(`${blocking} that must be resolved`);
  if (advisory > 0) parts.push(`${advisory} to confirm`);
  return `${result.discrepancies.length} difference(s) from the quotation: ${parts.join(", ")}.`;
}
