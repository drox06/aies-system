/**
 * Display formatting rules from Spec.md §6.6. Kept as pure functions, separate from the cell
 * components, so the rules are unit-testable and so exports/PDFs use exactly the same code the
 * screen does.
 */

/** Spec.md §6.6: "Asia/Manila fixed; store UTC." Never read the viewer's local zone — a
 *  technician's phone roaming onto a foreign carrier must not shift a delivery date. */
export const TIME_ZONE = "Asia/Manila";

/** Spec.md §6.6: "PHP is base." */
export const BASE_CURRENCY = "PHP";

const moneyFormatters = new Map<string, Intl.NumberFormat>();
const plainFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Spec.md §6.6: "Display ₱1,234,567.89. Never a bare number without its currency."
 *
 * Takes a string|number rather than only number because money arrives from Prisma as Decimal —
 * passing it through `Number()` at the call site is where precision quietly dies, so the
 * conversion is done here, once, and only for display.
 */
export function formatMoney(
  value: number | string | null | undefined,
  currency: string = BASE_CURRENCY,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";

  let fmt = moneyFormatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    moneyFormatters.set(currency, fmt);
  }
  return fmt.format(n);
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TIME_ZONE,
});

/** Spec.md §6.6: "DD MMM YYYY display". */
export function formatDate(value: Date | string | null | undefined): string {
  const d = toDate(value);
  return d ? dateFormatter.format(d) : "—";
}

export function formatDateTime(value: Date | string | null | undefined): string {
  const d = toDate(value);
  return d ? dateTimeFormatter.format(d) : "—";
}

/** Spec.md §6.6: "ISO in exports." Date-only, in Manila terms, so an export row matches what the
 *  screen showed rather than sliding a day either way. */
export function formatDateISO(value: Date | string | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  // en-CA renders ISO-shaped YYYY-MM-DD, and is the least awkward way to get a zoned date part.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).format(d);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Money for a **PDF**: the ISO code and the number, never a currency symbol.
 *
 * `formatMoney` produces `₱1,234.56`, which is right on screen and wrong on a document. The PDF
 * documents are drawn in Helvetica, whose WinAnsi encoding has no peso sign — every amount on a
 * downloaded quotation and costing sheet came out as `±1,234.56`, which a customer reads as a
 * tolerance. The euro sign happens to survive and the dollar always would, so the bug looked
 * currency-specific while the cause was the font.
 *
 * Embedding a font that carries ₱ would fix the glyph and leave a second problem: a document quoted
 * in dollars for an indent order, read in Manila, is ambiguous when it says only `$`. `USD` is not.
 * ISO codes are also what the customer's own finance department files against.
 */
export function formatMoneyCode(
  value: number | string | null | undefined,
  currency: string = BASE_CURRENCY,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";

  let fmt = plainFormatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    plainFormatters.set(currency, fmt);
  }
  return `${currency} ${fmt.format(n)}`;
}
