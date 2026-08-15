/**
 * Quotation costing, pricing and margin (specs/02-quotation.md §4).
 *
 * Pure — no Prisma, no database — so the quote builder can recompute totals as the user types and
 * get exactly the numbers the server will store. §1 calls this module "where margin is decided",
 * and a builder that disagrees with the server about the total is worse than one that shows nothing.
 *
 * ## Everything is integer centavos
 *
 * Not `number` pesos, and not Prisma's `Decimal`. Floating point cannot represent 0.1, so a quote
 * with forty lines accumulates error that shows up as a total ending in .99999998 — on a document
 * a customer signs. `Decimal` would be exact but lives in `@prisma/client`, and dragging the Prisma
 * runtime into the browser to add up a column is a bad trade (it is also what the
 * `no-restricted-imports` rule exists to stop).
 *
 * Integer minor units are exact, dependency-free, and safe here by a wide margin: `Number.MAX_SAFE_
 * INTEGER` is ₱90,071,992,547,409.91, and AIES quotes industrial instrumentation, not sovereign
 * debt. `assertRepresentable` fails loudly rather than silently losing precision if that is ever
 * wrong.
 *
 * ## Rounding is stated, not incidental
 *
 * Rounding happens at exactly two places: when a unit price is derived from cost, and when a line
 * total is computed. Both round half away from zero, the convention Philippine invoicing uses.
 * Everything downstream is integer addition, so subtotal, VAT and total are exact sums of numbers
 * that were each rounded once — never a re-rounding of a rounded figure.
 */

/** A money amount in integer minor units (centavos for PHP). */
export type Centavos = number;

/** ₱90,071,992,547,409.91 — beyond this, integer arithmetic stops being exact. */
const MAX_CENTAVOS = Number.MAX_SAFE_INTEGER;

function assertRepresentable(value: number, what: string): Centavos {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_CENTAVOS) {
    throw new Error(`${what} is too large to represent exactly in centavos: ${value}`);
  }
  return value;
}

/** Round half away from zero — the convention Philippine invoicing uses. */
function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Parses a decimal string or number into centavos.
 *
 * Strings are the wire format for money throughout this codebase precisely so a value never passes
 * through a float on its way from the form to the database. Parsing the digits directly keeps that
 * promise: `"1234.56"` becomes `123456` without `1234.56` ever existing as a float.
 */
export function toCentavos(value: string | number | null | undefined): Centavos {
  if (value === null || value === undefined || value === "") return 0;

  const text = typeof value === "number" ? value.toString() : value.trim();
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new Error(`Not a decimal amount: ${JSON.stringify(value)}`);

  const sign = match[1] ? -1 : 1;
  const whole = match[2] || "0";
  // Two minor digits, with the third used only to round the second.
  const frac = (match[3] || "").padEnd(3, "0");
  const centavos = Number(whole) * 100 + Number(frac.slice(0, 2));
  const rounded = Number(frac[2]) >= 5 ? centavos + 1 : centavos;

  return assertRepresentable(sign * rounded, "amount");
}

/** Formats centavos back to a plain decimal string, for the wire and for Prisma. */
export function fromCentavos(value: Centavos): string {
  const negative = value < 0;
  const abs = Math.abs(Math.trunc(value));
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The currencies a quotation can be raised in.
 *
 * Three, because those are the three AIES actually quotes in: pesos at home, and dollars or euros
 * for an indent order priced by a European or American principal. A free-text currency field would
 * accept "Php", "php" and "peso" and make the FX buffer meaningless.
 *
 * Not a database table: a currency list that changes is module 09's settings problem, and inventing
 * a second settings mechanism here is the trap this build has refused repeatedly.
 */
/**
 * §4's margin floor: "a warning when any line is below the configured floor".
 *
 * Here rather than in the PDF renderer, which is where it was first written. It is a pricing rule —
 * the costing sheet prints it, the what-if calculator tests against it, and §8's approval offer
 * turns on it — and a rule three callers need has no business living in a document.
 *
 * A constant until module 09's settings exist, like every other "configurable" value in this build.
 */
export const MARGIN_FLOOR_PCT = 15;

/**
 * The landed cost of one line, in the quotation's currency.
 *
 * **`QuotationLine.unitCost` holds the supplier's raw figure**, in `costCurrency`, exactly as they
 * quoted it. Landed cost — converted and buffered — is derived, here, by everything that needs it.
 *
 * It was the other way round until docs/DECISIONS.md #32: `unitCost` held the landed figure and
 * nothing recorded that it did, so no caller could tell a raw supplier price from a converted one.
 * Two bugs came out of that ambiguity, and both were arithmetic nobody could see: a EUR price stored
 * as pesos, and an FX buffer that compounded a little more every time somebody pressed Save.
 *
 * Storing the raw figure is also what §4 asks for in as many words — "Store `unitCost` in
 * `costCurrency` **and** the `costFxRate` used at the time of quoting" — and it makes a save
 * idempotent by construction: feeding a stored line back in produces the same numbers, because the
 * inputs are the inputs rather than a previous output.
 */
export function landedUnitCost(
  unitCost: string | number,
  costFxRate: string | number,
  fxBufferPct: string | number | null | undefined,
): Centavos {
  const landedFx = rate(costFxRate) * (1 + pct(fxBufferPct) / 100);
  return roundHalfUp(toCentavos(unitCost) * landedFx);
}

export const QUOTE_CURRENCIES = ["PHP", "USD", "EUR"] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];

export const CURRENCY_LABELS: Readonly<Record<QuoteCurrency, string>> = {
  PHP: "PHP — Philippine peso",
  USD: "USD — US dollar",
  EUR: "EUR — euro",
};

export const VAT_MODES = ["exclusive", "inclusive", "zero_rated", "exempt"] as const;
export type VatMode = (typeof VAT_MODES)[number];

export interface CostingLineInput {
  quantity: string | number;
  /** As quoted by the principal, in `costCurrency`. */
  unitCost: string | number;
  /** Rate to convert `costCurrency` into the quotation's currency. 1 when they are the same. */
  costFxRate?: string | number;
  /**
   * Markup on landed cost, as a percentage. When null the price was typed directly and the margin
   * is implied — §4 supports both because "engineers think in price, finance thinks in margin".
   */
  markupPct?: string | number | null;
  /** Used when `markupPct` is null. Ignored otherwise, since markup derives it. */
  unitPrice?: string | number | null;
  lineDiscountPct?: string | number | null;
  /** §7: shown on the quote but excluded from the total. */
  isOptional?: boolean;
}

export interface CostingLineResult {
  /** Landed unit cost in the quotation's currency, after FX and buffer. */
  unitCost: Centavos;
  unitPrice: Centavos;
  lineCost: Centavos;
  /**
   * After the line discount, **before** any header discount — the amount the customer sees against
   * this line on the document.
   *
   * The header discount is deliberately not folded in here. A document that showed already-reduced
   * line amounts *and* a discount row underneath would be showing the same reduction twice, and the
   * line amounts would not sum to the subtotal printed above them. §8's negotiation makes this
   * common rather than rare, so the document states the full price, then the discount, then the net.
   */
  lineTotal: Centavos;
  /**
   * This line's share of the header discount, distributed by its share of the subtotal.
   *
   * Carried separately so margin can account for it without the customer-facing amount moving —
   * §4 wants the discount "distributed proportionally across lines and recomputes margin", and it is
   * the *margin* half that the floor warning depends on.
   */
  discountShare: Centavos;
  /** Net of this line's share of the header discount. */
  lineMargin: Centavos;
  /** Null when the line has no price at all — a margin percentage of zero would be a lie. */
  marginPct: number | null;
  isOptional: boolean;
}

export interface CostingInput {
  lines: CostingLineInput[];
  /**
   * §4's "quote at BSP rate + 3%" buffer, applied on top of each line's FX rate. Held at the header
   * because it is one commercial decision about the whole quote, not a per-line fact.
   */
  fxBufferPct?: string | number | null;
  /** §4: "Header-level discount distributes proportionally across lines and recomputes margin." */
  headerDiscount?: string | number | null;
  vatMode?: VatMode;
  vatRatePct?: string | number | null;
  /** §4's margin floor. Lines below it are reported, not blocked — §11 has a permission to override. */
  marginFloorPct?: number | null;
}

export interface CostingResult {
  lines: CostingLineResult[];
  /** Sum of non-optional line totals, before the header discount. */
  subtotal: Centavos;
  discountAmount: Centavos;
  /** Subtotal less discount — the VAT base under `exclusive`. */
  netAmount: Centavos;
  vatAmount: Centavos;
  total: Centavos;
  totalCost: Centavos;
  marginAmount: Centavos;
  marginPct: number | null;
  /** Indices of lines below the margin floor, for §4's per-line heat colouring. */
  linesBelowFloor: number[];
}

function pct(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a percentage: ${JSON.stringify(value)}`);
  return n;
}

function rate(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 1;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Not an FX rate: ${JSON.stringify(value)}`);
  return n;
}

/**
 * Computes one quotation's costing, from line inputs to the total the customer sees.
 *
 * The order matters and is §4's: land the cost through FX and the buffer, derive or accept the
 * price, apply the line discount, sum the non-optional lines, distribute the header discount
 * proportionally, then apply VAT.
 */
export function computeCosting(input: CostingInput): CostingResult {
  const buffer = pct(input.fxBufferPct);
  const marginFloor = input.marginFloorPct ?? null;

  const lines: CostingLineResult[] = input.lines.map((line) => {
    const quantity = Number(line.quantity ?? 0);
    if (!Number.isFinite(quantity)) throw new Error(`Not a quantity: ${line.quantity}`);

    // Landed cost: the principal's price, converted, then buffered. The buffer inflates *cost*
    // rather than discounting price, because §4 frames it as protection against the rate having
    // moved by the time the order is placed.
    const landedFx = rate(line.costFxRate) * (1 + buffer / 100);
    const unitCost = assertRepresentable(
      roundHalfUp(toCentavos(line.unitCost) * landedFx),
      "unit cost",
    );

    const markup =
      line.markupPct === null || line.markupPct === undefined ? null : pct(line.markupPct);
    const unitPrice =
      markup === null
        ? toCentavos(line.unitPrice)
        : assertRepresentable(roundHalfUp(unitCost * (1 + markup / 100)), "unit price");

    const discount = pct(line.lineDiscountPct);
    const gross = roundHalfUp(unitPrice * quantity);
    const lineTotal = assertRepresentable(roundHalfUp(gross * (1 - discount / 100)), "line total");
    const lineCost = assertRepresentable(roundHalfUp(unitCost * quantity), "line cost");
    const lineMargin = lineTotal - lineCost;

    return {
      unitCost,
      unitPrice,
      lineCost,
      lineTotal,
      discountShare: 0,
      lineMargin,
      marginPct: lineTotal === 0 ? null : (lineMargin / lineTotal) * 100,
      isOptional: line.isOptional === true,
    };
  });

  // §7: optional lines appear on the document but never in the total, and they must not drag the
  // margin figure around either — quoting an alternate should not change the deal's margin.
  const counted = lines.filter((line) => !line.isOptional);

  const subtotal = counted.reduce((sum, line) => sum + line.lineTotal, 0);
  const requestedDiscount = toCentavos(input.headerDiscount);
  // Cannot discount below zero; a negative total is not a quotation.
  const discountAmount = Math.min(Math.max(requestedDiscount, 0), Math.max(subtotal, 0));
  const netAmount = subtotal - discountAmount;

  const totalCost = counted.reduce((sum, line) => sum + line.lineCost, 0);
  // The header discount comes straight off margin: the cost did not change because the customer
  // negotiated. This is the number §8's what-if calculator moves.
  const marginAmount = netAmount - totalCost;

  /**
   * §4: "Header-level discount distributes proportionally across lines and recomputes margin."
   *
   * **Into `discountShare`, not into `lineTotal`.** Two different readers want two different things
   * from this, and an earlier version served only one of them:
   *
   *   - *Margin* has to account for the discount, or a quotation discounted twenty per cent still
   *     reports healthy line margins and §4's floor warning stays silent on lines that are by then
   *     underwater.
   *   - *The customer's document* must keep showing the full line amount, because it also prints a
   *     discount row underneath. Reducing the amounts as well would show one reduction twice, and
   *     the printed line amounts would no longer sum to the subtotal printed above them.
   *
   * Distributed by share of `lineTotal`, with the rounding remainder given to the largest line so
   * the parts sum to the discount exactly. Optional lines are excluded, because they are not in the
   * subtotal the discount was taken from.
   */
  if (discountAmount > 0 && subtotal > 0) {
    const countedIndexes = lines.flatMap((line, index) => (line.isOptional ? [] : [index]));
    let allocated = 0;
    let largest = countedIndexes[0] ?? 0;

    for (const index of countedIndexes) {
      const line = lines[index]!;
      const share = roundHalfUp((line.lineTotal / subtotal) * discountAmount);
      line.discountShare = share;
      allocated += share;
      if (line.lineTotal > lines[largest]!.lineTotal) largest = index;
    }

    // The remainder is a centavo or two either way; putting it anywhere but the biggest line would
    // be visible as a rounding artefact on a small one.
    const remainder = discountAmount - allocated;
    if (remainder !== 0 && countedIndexes.length > 0) {
      lines[largest]!.discountShare += remainder;
    }

    for (const index of countedIndexes) {
      const line = lines[index]!;
      const net = line.lineTotal - line.discountShare;
      line.lineMargin = net - line.lineCost;
      line.marginPct = net === 0 ? null : (line.lineMargin / net) * 100;
    }
  }

  const vatRate = input.vatRatePct === undefined ? 12 : pct(input.vatRatePct);
  const vatMode: VatMode = input.vatMode ?? "exclusive";

  let vatAmount = 0;
  let total = netAmount;
  if (vatMode === "exclusive") {
    vatAmount = roundHalfUp(netAmount * (vatRate / 100));
    total = netAmount + vatAmount;
  } else if (vatMode === "inclusive") {
    // The net already contains the VAT; back it out so the document can show it as a line.
    vatAmount = roundHalfUp(netAmount - netAmount / (1 + vatRate / 100));
    total = netAmount;
  }
  // zero_rated and exempt: no VAT, and the distinction is a reporting one module 05 cares about.

  const linesBelowFloor =
    marginFloor === null
      ? []
      : lines.flatMap((line, index) =>
          !line.isOptional && line.marginPct !== null && line.marginPct < marginFloor
            ? [index]
            : [],
        );

  return {
    lines,
    subtotal,
    discountAmount,
    netAmount,
    vatAmount,
    total,
    totalCost,
    marginAmount,
    marginPct: netAmount === 0 ? null : (marginAmount / netAmount) * 100,
    linesBelowFloor,
  };
}

/**
 * §8's what-if calculator: what margin results from a given target total?
 *
 * Returns the header discount that reaches the target, so the caller can apply it through the same
 * `computeCosting` path rather than a second, divergent implementation of the same arithmetic.
 */
export function discountForTargetTotal(
  input: CostingInput,
  targetTotal: string | number,
): { discountAmount: Centavos; result: CostingResult } {
  const base = computeCosting({ ...input, headerDiscount: 0 });
  const target = toCentavos(targetTotal);
  const vatRate = input.vatRatePct === undefined ? 12 : pct(input.vatRatePct);
  const mode: VatMode = input.vatMode ?? "exclusive";

  // Work backwards from the target to the net the customer would be paying before VAT.
  const targetNet = mode === "exclusive" ? roundHalfUp(target / (1 + vatRate / 100)) : target;
  const discountAmount = Math.max(0, base.subtotal - targetNet);

  return {
    discountAmount,
    result: computeCosting({ ...input, headerDiscount: fromCentavos(discountAmount) }),
  };
}
