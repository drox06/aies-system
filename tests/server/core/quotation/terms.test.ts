import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getCompanyDetails } from "@/server/core/company";
import { buildCustomerPdfProps } from "@/server/core/quotation/pdf/render";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { updateQuotationHeaderService } from "@/server/core/quotation/quotation-line-service";
import {
  applyCustomerName,
  CUSTOMER_TOKEN,
  DEFAULT_TERMS_AND_CONDITIONS,
  termsFromRecord,
} from "@/server/core/quotation/terms";

/**
 * §7's terms, as the company supplied them.
 *
 * The build shipped with placeholder clauses and no way to enter the commercial terms at all — the
 * document printed "—" against delivery, payment and warranty because nothing could set them.
 *
 * The load-bearing property here is that the clauses live **on the quotation**, not in this file. A
 * quotation is a contract: the clauses the customer accepted are the ones printed on the document
 * they signed, not whichever set the company is using when somebody reprints it six months later.
 * So the last test in the first block is the one that matters most.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `terms-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Terms Test" };

const accountIds: string[] = [];
const quotationIds: string[] = [];

async function makeQuotation(customerName = `Maynilad Water ${suffix}`) {
  const account = await db.customerAccount.create({
    data: {
      code: `TC-${randomUUID().slice(0, 12)}`,
      name: customerName,
      ownerId: OWNER,
      billingAddress: { line1: "1 Katipunan Road", city: "Quezon City" },
    },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Supply and Installation of 1 set Sludge Level Meter and Communication",
  });
  quotationIds.push(quotation.id);
  return { account, quotation };
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the standard terms and conditions", () => {
  it("are the nine clauses the company supplied, in their order", () => {
    expect(DEFAULT_TERMS_AND_CONDITIONS).toHaveLength(9);
    const openers = DEFAULT_TERMS_AND_CONDITIONS.map((clause) => clause.split(".")[0]);
    expect(openers).toEqual([
      "ACCEPTANCE",
      "DELIVERY",
      "LEAD TIME",
      "FORCE MAJEURE",
      "QUOTATION VALIDITY",
      "BILLING",
      "TERMINATION",
      "PAYMENT TERMS",
      "WARRANTY",
    ]);
  });

  it("names the customer in clause 1 rather than leaving a template token on the document", () => {
    const filled = applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, "Maynilad Water Services, Inc.");
    expect(filled[0]).toContain("Maynilad Water Services, Inc.");
    expect(filled.join(" ")).not.toContain(CUSTOMER_TOKEN);

    // A raw `{{CUSTOMER}}` on a page a customer reads is worse than a vaguer sentence, so an empty
    // name falls back rather than printing the token.
    expect(applyCustomerName(DEFAULT_TERMS_AND_CONDITIONS, "   ")[0]).toContain("the customer");
  });

  it("are seeded onto the quotation at creation, with the customer's name already in them", async () => {
    const { account, quotation } = await makeQuotation();

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    const clauses = stored.termsAndConditions as string[];
    expect(clauses).toHaveLength(9);
    expect(clauses[0]).toContain(account.name);
    expect(clauses.join(" ")).not.toContain(CUSTOMER_TOKEN);
  });

  it("belong to the quotation — editing one does not touch another", async () => {
    const first = await makeQuotation("First Customer Inc");
    const second = await makeQuotation("Second Customer Inc");

    await updateQuotationHeaderService(actor, {
      quotationId: first.quotation.id,
      version: first.quotation.version,
      termsAndConditions: ["ACCEPTANCE. Negotiated wording for this deal only."],
    });

    const storedFirst = await db.quotation.findUniqueOrThrow({
      where: { id: first.quotation.id },
    });
    const storedSecond = await db.quotation.findUniqueOrThrow({
      where: { id: second.quotation.id },
    });
    expect(storedFirst.termsAndConditions).toHaveLength(1);
    expect(storedSecond.termsAndConditions).toHaveLength(9);
  });

  it("falls back to the defaults for a record created before the column existed", () => {
    // Existing quotations have `[]`. Printing a document with no terms at all would be worse than
    // printing the company's standard ones.
    expect(termsFromRecord([], "Some Customer")).toHaveLength(9);
    expect(termsFromRecord(null, "Some Customer")).toHaveLength(9);
    expect(termsFromRecord(["Just this one"], "Some Customer")).toEqual(["Just this one"]);
  });
});

describe("the commercial terms, which previously had no input at all", () => {
  it("reach the document once entered", async () => {
    const { quotation } = await makeQuotation();

    await updateQuotationHeaderService(actor, {
      quotationId: quotation.id,
      version: quotation.version,
      deliveryLeadTime: "35-45 working days from PO and downpayment",
      deliveryTermIncoterm: "DDP site, Mandaluyong",
      paymentTermsText: "100% Advance payment",
      warrantyTerms: "1 year warranty after completion of works",
    });

    const props = await buildCustomerPdfProps(quotation.id);
    expect(props.terms.deliveryLeadTime).toContain("35-45 working days");
    expect(props.terms.incoterm).toContain("DDP site");
    expect(props.terms.paymentTerms).toBe("100% Advance payment");
    expect(props.terms.warranty).toContain("1 year warranty");
  }, 60_000);

  it("prints the wording, never a payment-terms row id", async () => {
    // `paymentTermsId` is module 05's structured link. It used to be what the document printed,
    // which meant a customer could receive a page with a cuid on it where the payment terms belong.
    const { quotation } = await makeQuotation();
    await db.quotation.update({
      where: { id: quotation.id },
      data: { paymentTermsId: "clx0000000000000000000000", paymentTermsText: "50% down, 50% COD" },
    });

    const props = await buildCustomerPdfProps(quotation.id);
    expect(props.terms.paymentTerms).toBe("50% down, 50% COD");
  }, 60_000);

  it("carries the edited clauses onto the document, numbered in order", async () => {
    const { quotation } = await makeQuotation();

    await updateQuotationHeaderService(actor, {
      quotationId: quotation.id,
      version: quotation.version,
      termsAndConditions: ["First clause, edited.", "Second clause, added by hand."],
    });

    const props = await buildCustomerPdfProps(quotation.id);
    expect(props.standardTerms).toEqual(["First clause, edited.", "Second clause, added by hand."]);
  }, 60_000);
});

describe("the company block on the document", () => {
  it("breaks the address where the company says, not where the column happens to run out", async () => {
    // The street line was wrapping mid-address in the narrow header column.
    expect(getCompanyDetails().addressLines).toEqual([
      "930 Doña Basilisa Yangco Street,",
      "Barangay Namayan, Mandaluyong City, 1550, Philippines",
    ]);

    const { quotation } = await makeQuotation();
    const props = await buildCustomerPdfProps(quotation.id);
    expect(props.company.addressLines).toHaveLength(2);
    expect(props.company.addressLines[0]).toBe("930 Doña Basilisa Yangco Street,");
  }, 60_000);
});
