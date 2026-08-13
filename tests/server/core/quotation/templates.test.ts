import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createQuotationFromTemplateService,
  deactivateQuoteTemplateService,
  listQuoteTemplatesService,
  saveQuotationAsTemplateService,
} from "@/server/core/quotation/reuse-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { updateQuotationHeaderService } from "@/server/core/quotation/quotation-line-service";
import { CUSTOMER_TOKEN } from "@/server/core/quotation/terms";

/**
 * specs/02-quotation.md §9's quote templates.
 *
 * A template is the *shape* of a quotation with the customer removed. The assertions that matter are
 * about what it carries and what it deliberately does not: it keeps the slow part — scope, terms,
 * lines — and leaves out the customer, the dates and the number, which are the parts that are
 * different every time and cheap to supply.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `tpl-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const templateIds: string[] = [];

async function makeAccount(name: string) {
  const account = await db.customerAccount.create({
    data: { code: `TP-${randomUUID().slice(0, 12)}`, name, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

/** A costed quotation with terms filled in — the thing worth keeping the shape of. */
async function makeQuotation(accountId: string) {
  const quotation = await createQuotationService(actor, {
    accountId,
    title: "Annual preventive maintenance, 12 loops",
    scopeOfWork: "Quarterly PM visits on twelve control loops, including calibration certificates.",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      {
        description: "Quarterly PM visit",
        quantity: "4",
        unit: "visit",
        unitCost: "18000",
        markupPct: "30",
      },
      { description: "Calibration certificates", quantity: "12", unitCost: "800", markupPct: "40" },
    ],
  });

  const current = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
  await updateQuotationHeaderService(actor, {
    quotationId: quotation.id,
    version: current.version,
    deliveryLeadTime: "Within 5 working days of each scheduled quarter",
    paymentTermsText: "50% down, balance on completion of each visit",
    warrantyTerms: "Workmanship warranted for 90 days per visit",
  });

  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

afterAll(async () => {
  await db.quoteTemplateLine.deleteMany({ where: { templateId: { in: templateIds } } });
  await db.quoteTemplate.deleteMany({ where: { id: { in: templateIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...accountIds, ...templateIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

async function saveTemplate(quotationId: string, name = `PM contract ${randomUUID().slice(0, 6)}`) {
  const template = await saveQuotationAsTemplateService(actor, { quotationId, name });
  templateIds.push(template.id);
  return template;
}

describe("saving a quotation as a template", () => {
  it("keeps the scope, the terms and the lines", async () => {
    const account = await makeAccount(`Source Co ${suffix}`);
    const quotation = await makeQuotation(account.id);

    const template = await saveTemplate(quotation.id);

    expect(template.scopeOfWork).toContain("Quarterly PM visits");
    expect(template.paymentTermsText).toContain("50% down");
    expect(template.warrantyTerms).toContain("90 days");
    expect(template.lines).toHaveLength(2);
    // Raw cost and its rate, the same way a quotation line holds them (docs/DECISIONS.md #32).
    expect(template.lines[0]!.unitCost.toString()).toBe("18000");
    expect(template.lines[0]!.costFxRate.toString()).toBe("1");
  }, 60_000);

  it("keeps no trace of the customer it was built for", async () => {
    // The whole point of a template. If it carried the account, using it for somebody else would
    // mean remembering to change something the system already knows is wrong.
    const account = await makeAccount(`Private Co ${suffix}`);
    const quotation = await makeQuotation(account.id);

    const template = await saveTemplate(quotation.id);

    expect(JSON.stringify(template)).not.toContain(account.id);
    expect(JSON.stringify(template)).not.toContain(account.name);
    expect(JSON.stringify(template)).not.toContain(quotation.number);
  }, 60_000);

  it("refuses a second template with the same name", async () => {
    const account = await makeAccount(`Dup Co ${suffix}`);
    const quotation = await makeQuotation(account.id);
    const name = `Standard calibration ${randomUUID().slice(0, 6)}`;

    await saveTemplate(quotation.id, name);
    await expect(
      saveQuotationAsTemplateService(actor, { quotationId: quotation.id, name }),
    ).rejects.toThrow(/already a template called/);
  }, 60_000);

  it("refuses one with no lines", async () => {
    const account = await makeAccount(`Empty Co ${suffix}`);
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Nothing priced",
    });
    quotationIds.push(quotation.id);

    await expect(
      saveQuotationAsTemplateService(actor, { quotationId: quotation.id, name: `Empty ${suffix}` }),
    ).rejects.toThrow(/saves nobody any work/);
  }, 60_000);
});

describe("raising a quotation from a template", () => {
  it("produces an ordinary draft with its own number, for the customer given", async () => {
    const source = await makeAccount(`Template Source ${suffix}`);
    const quotation = await makeQuotation(source.id);
    const template = await saveTemplate(quotation.id);

    const customer = await makeAccount(`New Customer ${suffix}`);
    const started = await createQuotationFromTemplateService(actor, {
      templateId: template.id,
      accountId: customer.id,
    });
    quotationIds.push(started.id);

    expect(started.number).not.toBe(quotation.number);
    expect(started.revision).toBe(0);
    expect(started.status).toBe("draft");
    expect(started.accountId).toBe(customer.id);
    // A fresh clock, like any new quotation.
    expect(started.validUntil.getTime()).toBeGreaterThan(Date.now());
    expect(started.scopeOfWork).toContain("Quarterly PM visits");
    expect(started.paymentTermsText).toContain("50% down");
  }, 60_000);

  it("seeds the terms for the new customer, not the one the template came from", async () => {
    const source = await makeAccount(`First Client ${suffix}`);
    const quotation = await makeQuotation(source.id);
    const template = await saveTemplate(quotation.id);

    const customer = await makeAccount(`Second Client ${suffix}`);
    const started = await createQuotationFromTemplateService(actor, {
      templateId: template.id,
      accountId: customer.id,
    });
    quotationIds.push(started.id);

    const terms = started.termsAndConditions as string[];
    expect(terms[0]).toContain(customer.name);
    expect(terms[0]).not.toContain(source.name);
    expect(terms.join(" ")).not.toContain(CUSTOMER_TOKEN);
  }, 60_000);

  it("copies the lines with their costs", async () => {
    const source = await makeAccount(`Lines Source ${suffix}`);
    const quotation = await makeQuotation(source.id);
    const template = await saveTemplate(quotation.id);

    const customer = await makeAccount(`Lines Customer ${suffix}`);
    const started = await createQuotationFromTemplateService(actor, {
      templateId: template.id,
      accountId: customer.id,
    });
    quotationIds.push(started.id);

    const lines = await db.quotationLine.findMany({
      where: { quotationId: started.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.description).toBe("Quarterly PM visit");
    expect(lines[0]!.unitCost.toString()).toBe("18000");
    expect(lines[0]!.markupPct?.toString()).toBe("30");
  }, 60_000);

  it("refuses a customer that no longer exists", async () => {
    const source = await makeAccount(`Gone Co ${suffix}`);
    const quotation = await makeQuotation(source.id);
    const template = await saveTemplate(quotation.id);

    await expect(
      createQuotationFromTemplateService(actor, {
        templateId: template.id,
        accountId: "clx0000000000000000000000",
      }),
    ).rejects.toThrow(/customer no longer exists/);
  }, 60_000);
});

describe("retiring a template", () => {
  it("takes it off the list without deleting it", async () => {
    // A template that produced quotations is part of how they came to look the way they do.
    const account = await makeAccount(`Retire Co ${suffix}`);
    const quotation = await makeQuotation(account.id);
    const template = await saveTemplate(quotation.id);

    expect((await listQuoteTemplatesService()).map((t) => t.id)).toContain(template.id);

    await deactivateQuoteTemplateService(actor, { templateId: template.id });

    expect((await listQuoteTemplatesService()).map((t) => t.id)).not.toContain(template.id);
    expect(await db.quoteTemplate.findUnique({ where: { id: template.id } })).not.toBeNull();
  }, 60_000);

  it("will not raise a quotation from a retired one", async () => {
    const account = await makeAccount(`Retired Use ${suffix}`);
    const quotation = await makeQuotation(account.id);
    const template = await saveTemplate(quotation.id);
    await deactivateQuoteTemplateService(actor, { templateId: template.id });

    await expect(
      createQuotationFromTemplateService(actor, {
        templateId: template.id,
        accountId: account.id,
      }),
    ).rejects.toThrow(/no longer exists/);
  }, 60_000);
});
