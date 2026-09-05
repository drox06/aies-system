/**
 * Money and date formatting shared by every document under this directory.
 *
 * Centavos throughout, per every finance model's own convention — never the quotation module's
 * Decimal-pesos. "PHP " rather than "₱": Helvetica (the PDF base-14 font these documents use, so
 * nothing needs embedding) does not carry the peso glyph reliably across viewers.
 */

export const peso = (centavos: number): string =>
  `PHP ${(centavos / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const asDate = (value: Date): string =>
  value.toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" });

/** For a narrow table column, where the long form (`asDate`) overflows its cell and runs into the
 *  next one. Spec.md §6.6's own DD MMM YYYY convention — the same format the document PDFs use. */
export const shortDate = (value: Date): string =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(
    value,
  );
