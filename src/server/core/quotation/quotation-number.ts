/**
 * Quotation document numbers, as the company specified them.
 *
 * Pure — no Prisma — so the builder, the PDF and the list all render the same string.
 *
 * ## The format is the company's, not the spec's
 *
 * Spec.md §5's table says `QTN-{YY}{MM}-{####}` → `QTN-2608-0042`. AIES uses something different
 * and asked for it directly:
 *
 *   - Local customers:              `AIESLQ` + 2-digit year + 4-digit series → `AIESLQ260001`
 *   - Indent / international quotes: `AIESIQ` + 2-digit year + 4-digit series → `AIESIQ260001`
 *   - Revisions append `REV01`, `REV02`, …           → `AIESLQ260001REV01`
 *
 * This is their existing document convention, printed on quotations customers already hold, so the
 * spec's placeholder loses. See docs/DECISIONS.md #25.
 *
 * **Two independent series.** A local quote and an indent quote never share a counter, so the
 * fourth local quote of 2026 is `AIESLQ260004` whatever the indent side has issued. That is what
 * two document types in the numbering service buys — the scope key comes from the format's own date
 * tokens, so each series also restarts at 0001 each January without anybody resetting anything.
 */

export const QUOTE_TYPES = ["local", "indent"] as const;
export type QuoteType = (typeof QUOTE_TYPES)[number];

/**
 * The numbering-service document type per quote type.
 *
 * Separate types rather than one type with a prefix argument, because the counter is scoped by
 * document type — sharing one would interleave the two series.
 */
export const QUOTE_NUMBER_DOCUMENT_TYPES: Record<QuoteType, string> = {
  local: "quotation_local",
  indent: "quotation_indent",
};

/** The seeded formats, exported so the seed and the tests cannot disagree about them. */
export const QUOTE_NUMBER_FORMATS: Record<QuoteType, string> = {
  local: "AIESLQ{YY}{####}",
  indent: "AIESIQ{YY}{####}",
};

export function quoteTypeLabel(type: QuoteType): string {
  return type === "indent" ? "Indent / international" : "Local";
}

/**
 * The number as it appears on the document.
 *
 * R0 carries no suffix: the first issue of `AIESLQ260001` is just `AIESLQ260001`, and printing
 * `REV00` on an unrevised quotation would invite the question "where is revision zero?".
 *
 * Zero-padded to two digits because the company wrote `REV01`. A quotation reaching REV100 is a
 * negotiation that has gone badly wrong, and the number simply grows rather than truncating.
 */
export function quotationDisplayNumber(baseNumber: string, revision: number): string {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error(`Revision must be a non-negative integer, got ${revision}`);
  }
  if (revision === 0) return baseNumber;
  return `${baseNumber}REV${String(revision).padStart(2, "0")}`;
}

/**
 * Splits a display number back into its base and revision.
 *
 * Needed because the number is what people search for and quote at each other on the phone — a user
 * pasting `AIESLQ260001REV02` into search should find the quotation, not nothing.
 */
export function parseQuotationNumber(display: string): { baseNumber: string; revision: number } {
  const match = /^(.*?)REV(\d{2,})$/.exec(display.trim());
  if (!match) return { baseNumber: display.trim(), revision: 0 };
  return { baseNumber: match[1]!, revision: Number(match[2]) };
}

/** Which series a number came from, for display and for reporting. */
export function quoteTypeFromNumber(baseNumber: string): QuoteType | null {
  if (baseNumber.startsWith("AIESLQ")) return "local";
  if (baseNumber.startsWith("AIESIQ")) return "indent";
  return null;
}
