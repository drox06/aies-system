import { StyleSheet } from "@react-pdf/renderer";

/**
 * PDF styling, from Spec.md §6.2's confirmed palette and §6.4's "Applying it".
 *
 * The tokens are duplicated as hex literals rather than read from `globals.css`, because
 * `@react-pdf` has no CSS pipeline — it takes plain objects. They are the same values, and the
 * duplication is deliberate rather than accidental: a PDF is a legal document AIES sends to
 * customers, and it should not silently change colour because somebody adjusted a UI token.
 *
 * **Typography.** Spec.md §6.5 asks for "Inter, or a metrics-compatible fallback that embeds
 * cleanly." This uses Helvetica, which is one of the PDF base-14 fonts — it needs no embedding at
 * all, renders identically everywhere, and Inter was drawn to sit close to Helvetica's metrics, so
 * a document laid out in one does not reflow badly in the other. Registering Inter would mean
 * shipping a font file and embedding ~200kB into every quotation for a difference nobody outside
 * this repository would notice.
 */

export const PDF_COLORS = {
  navy800: "#012076",
  navy900: "#011860",
  blue600: "#003999",
  red500: "#EE010C",
  text: "#0F1B2A",
  textMuted: "#5A6B7D",
  border: "#DCE3EB",
  surface2: "#EEF2F7",
  danger: "#B3261E",
} as const;

/** A4 at 72dpi is 595×842pt. 40pt margins leave a printable width of 515pt. */
export const PAGE_PADDING = 40;
export const CONTENT_WIDTH = 595 - PAGE_PADDING * 2;

export const pdfStyles = StyleSheet.create({
  page: {
    paddingTop: PAGE_PADDING,
    paddingBottom: PAGE_PADDING + 24, // room for the fixed controlled-document footer
    paddingHorizontal: PAGE_PADDING,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: PDF_COLORS.text,
    lineHeight: 1.4,
  },

  // §6.4: "aies-logo.svg top-left, company block top-right, a 2 px rule in --aies-red-500 under
  // the header". The rule is the one place brand red earns its keep on the document.
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  logo: { width: 150 },
  companyBlock: { textAlign: "right", fontSize: 8, color: PDF_COLORS.textMuted, maxWidth: 220 },
  companyName: { fontFamily: "Helvetica-Bold", fontSize: 10, color: PDF_COLORS.navy800 },
  headerRule: { height: 2, backgroundColor: PDF_COLORS.red500, marginTop: 10, marginBottom: 14 },

  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 16, color: PDF_COLORS.navy800 },
  docNumber: { fontFamily: "Helvetica-Bold", fontSize: 11, color: PDF_COLORS.navy800 },

  sectionHeading: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: PDF_COLORS.navy800,
    marginTop: 14,
    marginBottom: 4,
  },

  twoCol: { flexDirection: "row", justifyContent: "space-between", gap: 24 },
  col: { flex: 1 },
  label: { fontSize: 7.5, color: PDF_COLORS.textMuted, textTransform: "uppercase" },
  value: { fontSize: 9 },

  // Tables. Spec.md §6.5: tabular figures in every money and quantity column.
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.navy800,
    paddingBottom: 3,
    marginTop: 4,
  },
  th: { fontFamily: "Helvetica-Bold", fontSize: 8, color: PDF_COLORS.navy800 },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.border,
    paddingVertical: 3,
  },
  groupRow: { backgroundColor: PDF_COLORS.surface2, paddingVertical: 3, paddingHorizontal: 2 },
  groupLabel: { fontFamily: "Helvetica-Bold", fontSize: 8.5, color: PDF_COLORS.navy800 },
  right: { textAlign: "right" },

  totalsBlock: { marginTop: 10, marginLeft: "auto", width: 220 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  totalsGrand: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.navy800,
    paddingTop: 4,
    marginTop: 2,
  },
  bold: { fontFamily: "Helvetica-Bold" },
  muted: { color: PDF_COLORS.textMuted },
  small: { fontSize: 8 },

  optionalNote: {
    fontSize: 8,
    color: PDF_COLORS.textMuted,
    fontStyle: "italic",
    marginTop: 3,
  },

  terms: { fontSize: 7.5, color: PDF_COLORS.textMuted, lineHeight: 1.5 },

  signatureRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 28, gap: 32 },
  signatureBox: { flex: 1 },
  signatureLine: {
    borderTopWidth: 0.75,
    borderTopColor: PDF_COLORS.text,
    marginTop: 34,
    paddingTop: 3,
  },

  // §6.4's controlled-document footer: "Doc No. / Rev. / Page x of y".
  footer: {
    position: "absolute",
    bottom: 20,
    left: PAGE_PADDING,
    right: PAGE_PADDING,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: PDF_COLORS.border,
    paddingTop: 4,
    fontSize: 7,
    color: PDF_COLORS.textMuted,
  },

  // The internal costing sheet only. §7: "watermarked INTERNAL".
  watermark: {
    position: "absolute",
    top: 300,
    left: 90,
    fontSize: 90,
    fontFamily: "Helvetica-Bold",
    color: PDF_COLORS.danger,
    opacity: 0.12,
    transform: "rotate(-30deg)",
  },
  internalBanner: {
    backgroundColor: PDF_COLORS.danger,
    color: "#FFFFFF",
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    padding: 5,
    marginBottom: 10,
    textAlign: "center",
  },
});
