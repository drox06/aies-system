import type { BillingTrigger, TermMilestone } from "@/server/core/finance/billing-rules";

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

/**
 * The five commercial fields a quotation is actually quoted on, regenerated as clause text.
 *
 * ## Why this exists
 *
 * A structured picker for delivery, lead time, validity, payment terms and warranty used to sit
 * above the clause editor and was removed on 2026-08-16 because it printed the same fact twice — the
 * picker's value in a summary block, the same value again inside the numbered clause below it, two
 * copies somebody had to keep in step by hand. Removing the picker fixed the duplication but also
 * removed the only way to enter these facts at all, `paymentTermsId` included — which is what
 * `generateScheduleService` reads to build a billing plan (docs/DECISIONS.md #150, finding 2).
 *
 * The fix here is not to bring the summary block back. It is to make the picker **write the clause
 * itself** — one value, one place it lives, the numbered clause is simply how it is displayed. There
 * is nothing left to drift, because there is only one copy.
 *
 * The clause stays a plain editable string afterward, same as any other — a person can still hand-tune
 * the wording for one deal. Changing the picker again regenerates the whole clause from the template,
 * overwriting whatever was there, which is deliberate: the picker is the fast, correct way to set it,
 * and it always wins when used.
 */

const MILESTONE_PHRASES: Readonly<Record<BillingTrigger, string>> = {
  on_order: "upon order confirmation",
  on_supplier_order: "upon order confirmation",
  on_delivery: "upon delivery",
  on_installation: "upon completion of installation",
  on_tc_accepted: "upon acceptance of commissioning",
  on_dr_signed: "upon signed delivery",
  on_project_close: "upon completion of the works",
  net_days_after_close: "", // built specially in paymentTermsClause, using daysAfter
};

export interface PaymentTermForClause {
  milestones: TermMilestone[];
}

/** The wording for the "PAYMENT TERMS." clause, derived from the selected term's actual milestones —
 *  never from `PaymentTerm.description`, which carries internal rationale (cash position, why the
 *  company offers it) that has no place on a document the customer reads. */
export function paymentTermsClause(term: PaymentTermForClause | null): string {
  if (!term || term.milestones.length === 0) {
    return "PAYMENT TERMS. 100% Advance payment.";
  }
  const parts = term.milestones.map((milestone) => {
    const phrase =
      milestone.trigger === "net_days_after_close"
        ? `${milestone.daysAfter ?? 30} days after completion of the works`
        : MILESTONE_PHRASES[milestone.trigger];
    return `${milestone.pct}% ${phrase}`;
  });
  return `PAYMENT TERMS. ${parts.join(", ")}.`;
}

export function deliveryClause(incoterm: string | null): string {
  const term = incoterm?.trim();
  const opening = term ? `Delivery term: ${term}. ` : "";
  return (
    `DELIVERY. ${opening}Unless instructions to the contrary are stated on the order, transport ` +
    "arrangements will be made by AIES ELECTROMECHANICAL CORPORATION on behalf of the customer for " +
    "dispatch of the goods to the point of delivery indicated on the quotation. If transport is " +
    "arranged by the customer, the risk in the goods shall be passed to the customer immediately " +
    "after the goods leave the custodianship of AIES ELECTROMECHANICAL CORPORATION."
  );
}

export function leadTimeClause(leadTime: string | null): string {
  const value = leadTime?.trim() || "35-45 working days";
  return (
    `LEAD TIME. Delivery lead time is ${value} upon confirmed receipt of Purchase Order and Down ` +
    "payment, excluding weekends. If due to unforeseen circumstances the customer requires the " +
    "delivery time set out in this agreement to be altered, the customer must provide a notice in " +
    "writing not less than four weeks prior to the said delivery time. AIES will use its reasonable " +
    "endeavours to meet the new delivery time requested by the customer but reserves the right to " +
    "charge the customer for any increase in cost to AIES incurred in meeting the new delivery time."
  );
}

/** Spec.md §6.6's display format, fixed to Asia/Manila regardless of the reader's own clock — the
 *  same convention `render.tsx`'s `fmtDate` uses for the rest of the document. */
function fmtDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(value);
}

export function validityClause(validUntil: Date | string | null): string {
  if (!validUntil) {
    return (
      "QUOTATION VALIDITY. Quoted prices are valid for 30 days from the date of the quotation " +
      "unless agreed to in writing stating otherwise."
    );
  }
  const date = typeof validUntil === "string" ? new Date(validUntil) : validUntil;
  return (
    `QUOTATION VALIDITY. This quotation is valid until ${fmtDate(date)}. Prices quoted are subject ` +
    "to change after this date unless agreed to in writing stating otherwise."
  );
}

export function warrantyClause(warranty: string | null): string {
  const value = warranty?.trim() || "1 year";
  return `WARRANTY. ${value} warranty after completion of works.`;
}

/** Label each generator's clause is keyed by, for `replaceClause`. */
export const CLAUSE_PREFIXES = {
  delivery: "DELIVERY.",
  leadTime: "LEAD TIME.",
  validity: "QUOTATION VALIDITY.",
  paymentTerms: "PAYMENT TERMS.",
  warranty: "WARRANTY.",
} as const;

/** Replaces the clause beginning with `prefix`; appends `text` as a new clause if none does — a
 *  person may have deleted it, and the picker should still be able to say what it stands for. */
export function replaceClause(clauses: readonly string[], prefix: string, text: string): string[] {
  const index = clauses.findIndex((clause) => clause.startsWith(prefix));
  if (index === -1) return [...clauses, text];
  const next = [...clauses];
  next[index] = text;
  return next;
}
