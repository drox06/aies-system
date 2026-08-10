/**
 * AIES's standard terms and conditions (specs/02-quotation.md §7).
 *
 * These are the company's own wording, supplied by them, replacing the placeholder clauses this
 * build shipped with. Pure — no Prisma — so the editor and the PDF share one source.
 *
 * ## Why they are copied onto each quotation rather than read from here at print time
 *
 * A quotation is a contract. The clauses the customer accepted are the ones printed on the document
 * they signed, not the ones the company happens to be using six months later. So
 * `createQuotationService` seeds `Quotation.termsAndConditions` from this list, and after that the
 * record owns its own terms — editable line by line, and frozen once sent along with everything
 * else (§5's immutability).
 *
 * ## The customer name
 *
 * Clause 1 names the client. `{{CUSTOMER}}` is substituted with the account name when the terms are
 * seeded, so the clause reads as the company wrote it without anyone retyping the name. Any clause
 * may use the token.
 */

export const CUSTOMER_TOKEN = "{{CUSTOMER}}";

export const DEFAULT_TERMS_AND_CONDITIONS: readonly string[] = [
  `ACCEPTANCE. That ${CUSTOMER_TOKEN} known here as the "client" and "customer" shall agree to AIES ELECTROMECHANICAL CORPORATION'S (otherwise known as AIES) Terms and Conditions, and full commitment to the order(s). Acceptance of this quotation serves as a binding contract between AIES and the customer.`,

  "DELIVERY. Unless instructions to the contrary are stated on the order, transport arrangements will be made by AIES ELECTROMECHANICAL CORPORATION on behalf of the customer for dispatch of the goods to the point of delivery indicated on the quotation. If transport is arranged by the customer, the risk in the goods shall be passed to the customer immediately after the goods leave the custodianship of AIES ELECTROMECHANICAL CORPORATION.",

  "LEAD TIME. Delivery lead time is 35-45 working days upon confirmed receipt of Purchase Order and Down payment, excluding weekends. If due to unforeseen circumstances the customer requires the delivery time set out in this agreement to be altered, the customer must provide a notice in writing not less than four weeks prior to the said delivery time. AIES will use its reasonable endeavours to meet the new delivery time requested by the customer but reserves the right to charge the customer for any increase in cost to AIES incurred in meeting the new delivery time.",

  "FORCE MAJEURE. In the event of uncontrolled factors, such as acts of God, of nature, labor strikes, and the like, causing excessive delay or stoppage in the completion of the order, we shall postpone the delivery until such time that the situation becomes normal again.",

  "QUOTATION VALIDITY. Quoted prices are valid for 30 days. Period from the date of the quotation unless agreed to in writing stating otherwise.",

  "BILLING. This is only a quotation. Official/Final Prices shall be reflected in the Sales Invoice.",

  "TERMINATION. Should the customer seek to terminate the Contract/Purchase Order after the purchase has been confirmed and the order has already been processed by the manufacturer, the customer will be liable for paying AIES the full amount of the Contract/Purchase Order, the cost of settling any legally justified claims in connection with the necessary termination of sub contracts entered into in respect of the Contract or part thereof and any other associated cost or claim in respect of the cancelled order or contract.",

  "PAYMENT TERMS. 100% Advance payment.",

  "WARRANTY. 1 year Warranty after completion of works.",
];

/**
 * Fills the customer token.
 *
 * Falls back to the generic phrasing rather than leaving `{{CUSTOMER}}` visible — a raw template
 * token on a document a customer reads is worse than a slightly vaguer sentence.
 */
export function applyCustomerName(terms: readonly string[], customerName: string): string[] {
  const name = customerName.trim() || "the customer";
  return terms.map((term) => term.split(CUSTOMER_TOKEN).join(name));
}

/** Reads whatever is stored, falling back to the defaults for records created before this existed. */
export function termsFromRecord(stored: unknown, customerName: string): string[] {
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.filter((line): line is string => typeof line === "string");
  }
  return applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, customerName);
}
