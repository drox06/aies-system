import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { getCompanyDetails } from "@/server/core/company";
import { formatMoneyCode } from "@/lib/format";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import { termsFromRecord } from "@/server/core/quotation/terms";
import {
  QuotationDocument,
  type CustomerLine,
  type CustomerQuotationPdfProps,
} from "./QuotationDocument";
import {
  CostingSheetDocument,
  type CostingLine,
  type CostingSheetPdfProps,
} from "./CostingSheetDocument";
import { RfqDocument, type RfqPdfProps } from "./RfqDocument";

/**
 * Assembling a quotation into one of the two documents (specs/02-quotation.md §7).
 *
 * All formatting happens here, not in the components: the documents receive pre-formatted strings
 * and render them. That keeps every amount on the page going through `formatMoneyCode` — Spec.md
 * §6.6 forbids "a bare number without its currency", and on a PDF the currency is written as its
 * ISO code because the document font has no peso glyph — and it means the
 * documents contain no arithmetic that could disagree with the record.
 */

/** Read once per process. The lockup is ~200kB and identical on every quotation. */
let cachedLogo: string | null = null;
function logoDataUri(): string {
  if (cachedLogo) return cachedLogo;
  const bytes = readFileSync(join(process.cwd(), "public", "brand", "aies-logo-pdf.png"));
  cachedLogo = `data:image/png;base64,${bytes.toString("base64")}`;
  return cachedLogo;
}

function fmtDate(value: Date | null | undefined): string {
  if (!value) return "—";
  // Spec.md §6.6: DD MMM YYYY for display, Asia/Manila fixed.
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(value);
}

async function loadQuotation(quotationId: string) {
  const quotation = await db.quotation.findFirst({
    where: { id: quotationId, deletedAt: null },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      account: true,
      site: true,
      contact: true,
    },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  return quotation;
}

type LoadedQuotation = Awaited<ReturnType<typeof loadQuotation>>;

/** Philippine addresses are stored as a JSON block; flatten whatever is there into a line. */
function addressLine(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const parts = Object.values(address as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

function preparedByLabel(quotation: LoadedQuotation): Promise<string> {
  return db.user
    .findUnique({ where: { id: quotation.preparedById }, select: { name: true } })
    .then((user) => user?.name ?? "AIES Electromechanical Corporation");
}

/**
 * The customer document.
 *
 * Note what is *not* passed: no cost, markup or margin reaches `CustomerQuotationPdfProps`, because
 * that type cannot express them. §7's "cost columns must never appear" is enforced by the compiler
 * rather than by this function remembering.
 */
export async function buildCustomerPdfProps(
  quotationId: string,
): Promise<CustomerQuotationPdfProps> {
  const quotation = await loadQuotation(quotationId);
  const company = getCompanyDetails();
  const currency = quotation.currency;

  const lines: CustomerLine[] = quotation.lines.map((line) => ({
    lineNo: line.lineNo,
    groupLabel: line.groupLabel,
    description: line.description,
    longDescription: line.longDescription,
    manufacturer: line.manufacturer,
    modelNumber: line.modelNumber,
    quantity: line.quantity.toString(),
    unit: line.unit,
    unitPrice: formatMoneyCode(line.unitPrice.toString(), currency),
    lineTotal: formatMoneyCode(line.lineTotal.toString(), currency),
    leadTimeDays: line.leadTimeDays,
    isOptional: line.isOptional,
  }));

  const discount = quotation.discountAmount.toString();
  const vat = quotation.vatAmount.toString();
  const vatLabel =
    quotation.vatMode === "inclusive"
      ? `VAT (${quotation.vatRatePct}% inclusive)`
      : quotation.vatMode === "exclusive"
        ? `VAT ${quotation.vatRatePct}%`
        : quotation.vatMode === "zero_rated"
          ? "VAT zero-rated"
          : "VAT exempt";

  return {
    documentNumber: quotationDisplayNumber(quotation.number, quotation.revision),
    revision: quotation.revision,
    title: quotation.title,
    issuedOn: fmtDate(quotation.sentAt ?? new Date()),
    validUntil: fmtDate(quotation.validUntil),
    company,
    customer: {
      name: quotation.account.name,
      code: quotation.account.code,
      address: addressLine(quotation.account.billingAddress),
      contactName: quotation.contact
        ? `${quotation.contact.firstName} ${quotation.contact.lastName}`.trim()
        : null,
      contactEmail: quotation.contact?.email ?? null,
    },
    site: quotation.site
      ? { name: quotation.site.name, address: addressLine(quotation.site.address) }
      : null,
    scopeOfWork: quotation.scopeOfWork,
    exclusions: quotation.exclusions,
    assumptions: quotation.assumptions,
    lines,
    totals: {
      subtotal: formatMoneyCode(quotation.subtotal.toString(), currency),
      discount: Number(discount) > 0 ? formatMoneyCode(discount, currency) : null,
      vatLabel,
      vat: Number(vat) > 0 ? formatMoneyCode(vat, currency) : null,
      grandTotal: formatMoneyCode(quotation.total.toString(), currency),
    },
    terms: {
      deliveryLeadTime: quotation.deliveryLeadTime,
      incoterm: quotation.deliveryTermIncoterm,
      // The printed wording. `paymentTermsId` stays for module 05's structured link.
      paymentTerms: quotation.paymentTermsText ?? quotation.paymentTermsId,
      warranty: quotation.warrantyTerms,
    },
    preparedBy: await preparedByLabel(quotation),
    logoSrc: logoDataUri(),
    // From the record, so a quotation prints the clauses that were on it — not whichever set the
    // company happens to be using now.
    standardTerms: termsFromRecord(quotation.termsAndConditions, quotation.account.name),
  };
}

/**
 * Assembly and rendering are separate functions on purpose.
 *
 * `@react-pdf` compresses its content streams and subsets its fonts with custom encodings, so the
 * finished bytes cannot be searched for text — the same reason the company's own template PDF could
 * not be read earlier in this build. Grepping the output for "7531" to prove cost never leaks would
 * pass whether the guarantee held or not, which is worse than no test.
 *
 * The props *are* the document's complete input: nothing reaches a page that did not come through
 * this object. So the guarantee is tested by scanning the props, which is both stronger and
 * readable. The render function then only has to be proved to produce a real PDF.
 */
export async function renderCustomerQuotationPdf(quotationId: string): Promise<Buffer> {
  return renderToBuffer(<QuotationDocument {...await buildCustomerPdfProps(quotationId)} />);
}

/** §4's margin floor, until module 09's settings can hold it. */
export const MARGIN_FLOOR_PCT = 15;

export async function buildCostingPdfProps(
  quotationId: string,
  generatedFor: string,
): Promise<CostingSheetPdfProps> {
  const quotation = await loadQuotation(quotationId);
  const currency = quotation.currency;

  const lines: CostingLine[] = quotation.lines.map((line) => {
    const lineTotal = Number(line.lineTotal);
    const marginPct = lineTotal === 0 ? null : (Number(line.lineMargin) / lineTotal) * 100;
    return {
      lineNo: line.lineNo,
      groupLabel: line.groupLabel,
      description: line.description,
      quantity: line.quantity.toString(),
      unit: line.unit,
      unitCost: formatMoneyCode(line.unitCost.toString(), currency),
      unitPrice: formatMoneyCode(line.unitPrice.toString(), currency),
      lineCost: formatMoneyCode(line.lineCost.toString(), currency),
      lineTotal: formatMoneyCode(line.lineTotal.toString(), currency),
      lineMargin: formatMoneyCode(line.lineMargin.toString(), currency),
      marginPct: marginPct === null ? null : `${marginPct.toFixed(1)}%`,
      belowFloor: !line.isOptional && marginPct !== null && marginPct < MARGIN_FLOOR_PCT,
      isOptional: line.isOptional,
    };
  });

  return {
    documentNumber: quotationDisplayNumber(quotation.number, quotation.revision),
    revision: quotation.revision,
    title: quotation.title,
    generatedOn: fmtDate(new Date()),
    generatedFor,
    company: { name: getCompanyDetails().name },
    customer: { name: quotation.account.name, code: quotation.account.code },
    currency,
    fxNote:
      Number(quotation.fxBufferPct) > 0
        ? `Supplier costs landed at the rate recorded on each line, plus a ${quotation.fxBufferPct}% FX buffer.`
        : null,
    lines,
    totals: {
      subtotal: formatMoneyCode(quotation.subtotal.toString(), currency),
      totalCost: formatMoneyCode(quotation.totalCost.toString(), currency),
      marginAmount: formatMoneyCode(quotation.marginAmount.toString(), currency),
      marginPct:
        Number(quotation.subtotal) === 0 ? null : `${Number(quotation.marginPct).toFixed(1)}%`,
      grandTotal: formatMoneyCode(quotation.total.toString(), currency),
    },
    marginFloorPct: MARGIN_FLOOR_PCT,
  };
}

export async function renderCostingSheetPdf(
  quotationId: string,
  generatedFor: string,
): Promise<Buffer> {
  return renderToBuffer(
    <CostingSheetDocument {...await buildCostingPdfProps(quotationId, generatedFor)} />,
  );
}

/**
 * §3.2's attachable request.
 *
 * Assembled here with the other documents so `logoDataUri` and the date formatter stay in one place,
 * and split from the renderer for the same reason the others are: props can be asserted on, bytes
 * cannot.
 */
export async function buildRfqPdfProps(rfqId: string): Promise<RfqPdfProps> {
  const rfq = await db.supplierQuoteRequest.findFirstOrThrow({
    where: { id: rfqId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });

  const supplier = await db.principalProspect.findUnique({
    where: { id: rfq.supplierId },
    select: { companyName: true, contactName: true },
  });
  const requester = await db.user.findUnique({
    where: { id: rfq.requestedById },
    select: { name: true },
  });

  return {
    number: rfq.number,
    issuedOn: fmtDate(rfq.sentAt ?? rfq.createdAt),
    dueBy: rfq.dueBy ? fmtDate(rfq.dueBy) : null,
    company: getCompanyDetails(),
    supplier: {
      name: supplier?.companyName ?? "Supplier",
      contactName: supplier?.contactName ?? null,
    },
    // Any free-text note went into the stored request body when the RFQ was raised, so it is not
    // re-derived here: the PDF carries the line list and the questions, the email carries the rest.
    notes: null,
    lines: rfq.lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      manufacturer: line.manufacturer,
      modelNumber: line.modelNumber,
      quantity: line.quantity.toString(),
      unit: line.unit,
    })),
    requestedBy: requester?.name ?? rfq.requestedById,
    logoSrc: logoDataUri(),
  };
}

export async function renderRfqPdf(rfqId: string): Promise<Buffer> {
  return renderToBuffer(<RfqDocument {...await buildRfqPdfProps(rfqId)} />);
}
