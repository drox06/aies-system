import { renderToBuffer } from "@react-pdf/renderer";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { getCompanyDetails } from "@/server/core/company";
import { formatMoneyCode } from "@/lib/format";
import { fmtDate, logoDataUri } from "@/server/core/quotation/pdf/render";
import { SupplierPoDocument, type SupplierPoPdfProps } from "./SupplierPoDocument";

/**
 * Assembling a supplier PO into its document (specs/03-order-procurement.md §5).
 *
 * Split from the renderer for the same reason module 02's is: `@react-pdf` compresses its content
 * streams and subsets its fonts, so the finished bytes cannot be searched for text. Grepping the
 * output to prove something is on the page would pass whether it was or not. The props *are* the
 * document's complete input, so asserting on them is the real test.
 *
 * `logoDataUri` and `fmtDate` are imported from module 02's renderer rather than copied. The logo is
 * ~200kB and cached per process; a second cache would double that for no reason, and a second date
 * formatter is how two documents in the same envelope end up with two date formats.
 */

/** Philippine addresses are stored as a JSON block; flatten whatever is there into lines. */
function addressLines(address: unknown): string[] {
  if (!address || typeof address !== "object") return [];
  return Object.values(address as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

export async function buildSupplierPoPdfProps(supplierPOId: string): Promise<SupplierPoPdfProps> {
  const po = await db.supplierPO.findFirst({
    where: { id: supplierPOId, deletedAt: null },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      supplier: true,
      salesOrder: { include: { site: true } },
    },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  const approver = po.approvedById
    ? await db.user.findUnique({ where: { id: po.approvedById }, select: { name: true } })
    : null;

  const company = getCompanyDetails();

  return {
    number: po.number,
    poDate: fmtDate(po.poDate),
    company,
    supplier: {
      name: po.supplier.name,
      contactName: po.supplier.contactName,
      addressLines: addressLines(po.supplier.address),
      paymentTerms: po.supplier.paymentTerms,
    },
    currency: po.currency,
    incoterm: po.incoterm,
    shipmentMode: po.shipmentMode,
    expectedShipDate: po.expectedShipDate ? fmtDate(po.expectedShipDate) : null,
    expectedArrivalDate: po.expectedArrivalDate ? fmtDate(po.expectedArrivalDate) : null,
    // The customer's site when there is one, so goods that ship direct go to the right place;
    // otherwise AIES's own address. The customer's *name* is deliberately not passed — a supplier
    // who learns whose job this is has what they need to go around AIES, the same reasoning that
    // keeps it off the RFQ.
    deliverTo: {
      addressLines:
        po.salesOrder?.site && addressLines(po.salesOrder.site.address).length > 0
          ? addressLines(po.salesOrder.site.address)
          : [company.name, ...company.addressLines],
    },
    lines: po.lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      manufacturer: line.manufacturer,
      modelNumber: line.modelNumber,
      quantity: line.quantity.toString(),
      unit: line.unit,
      // Every amount goes through `formatMoneyCode` — Spec.md §6.6 forbids a bare number without
      // its currency, and on a PDF the currency is written as its ISO code because the document
      // font has no peso glyph (docs/DECISIONS.md #31).
      unitCost: formatMoneyCode(line.unitCost.toString(), po.currency),
      lineTotal: formatMoneyCode(line.lineTotal.toString(), po.currency),
      leadTimeDays: line.leadTimeDays,
    })),
    // The **subtotal**, not the total: freight, duties and brokerage are AIES's own costs of
    // landing the goods and are not part of what this supplier is owed.
    subtotal: po.subtotal.toFixed(2),
    notes: po.notes,
    approvedBy: approver?.name ?? null,
    logoSrc: logoDataUri(),
  };
}

export async function renderSupplierPoPdf(supplierPOId: string): Promise<Buffer> {
  return renderToBuffer(<SupplierPoDocument {...await buildSupplierPoPdfProps(supplierPOId)} />);
}

/**
 * §5's other artefact: "the system generates the branded PO PDF **and the draft email text**".
 *
 * Plain text rather than HTML, because it is pasted into whatever mail client the buyer uses and
 * anything richer arrives as markup. Same shape as the RFQ's request body, which the company has
 * been using since module 02.
 */
export async function buildSupplierPoEmailText(supplierPOId: string): Promise<string> {
  const po = await db.supplierPO.findFirst({
    where: { id: supplierPOId, deletedAt: null },
    include: { supplier: true, lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  const greeting = po.supplier.contactName ? `Dear ${po.supplier.contactName},` : "Good day,";
  const lines = po.lines
    .map((line) => `  ${line.lineNo}. ${line.description} — ${line.quantity} ${line.unit}`)
    .join("\n");

  return [
    greeting,
    "",
    `Please find attached our purchase order ${po.number}, dated ${fmtDate(po.poDate)}, for:`,
    "",
    lines,
    "",
    `Order total: ${formatMoneyCode(po.subtotal.toString(), po.currency)}.`,
    po.expectedArrivalDate
      ? `We need these on site by ${fmtDate(po.expectedArrivalDate)}.`
      : "Please confirm your earliest delivery date.",
    "",
    `Kindly acknowledge receipt of this order, quoting ${po.number}, and confirm the delivery date.`,
    "Please quote our order number on your packing list and invoice.",
    "",
    "Thank you.",
    "",
    getCompanyDetails().name,
  ].join("\n");
}
