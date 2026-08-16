import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildSupplierPoEmailText, buildSupplierPoPdfProps } from "@/server/core/order/pdf/render";

/**
 * §5's two artefacts: "the system generates the branded PO PDF and the draft email text".
 *
 * Asserted on the **props**, not the bytes. `@react-pdf` compresses its content streams and subsets
 * its fonts with custom encodings, so the finished PDF cannot be searched for text — grepping the
 * output to prove a number is absent would pass whether the guarantee held or not. The props are the
 * document's complete input, so this is the real test. Same reasoning as module 02's PDF tests.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `pdf-${suffix}`;

const supplierIds: string[] = [];
const supplierPoIds: string[] = [];

async function makePo(overrides: { freight?: string; notes?: string } = {}) {
  const supplier = await db.supplier.create({
    data: {
      code: `PDF-${randomUUID().slice(0, 10)}`,
      name: `Präzision Messtechnik ${suffix}`,
      contactName: "Herr Vogel",
      currency: "EUR",
      paymentTerms: "30 days from invoice",
      address: { line1: "Industriestrasse 4", city: "Hamburg" },
    },
  });
  supplierIds.push(supplier.id);

  const po = await db.supplierPO.create({
    data: {
      number: `PO-26-${randomUUID().slice(0, 5)}`,
      supplierId: supplier.id,
      currency: "EUR",
      subtotal: "12000.00",
      freight: overrides.freight ?? "0",
      total: (12000 + Number(overrides.freight ?? 0)).toFixed(2),
      incoterm: "FOB Hamburg",
      shipmentMode: "sea",
      notes: overrides.notes ?? null,
      createdById: OWNER,
      lines: {
        create: [
          {
            lineNo: 1,
            description: "Electromagnetic flow meter DN150",
            manufacturer: "Präzision",
            modelNumber: "PM-150-E",
            quantity: "2",
            unit: "pc",
            unitCost: "5000.00",
            lineTotal: "10000.00",
            leadTimeDays: 45,
          },
          {
            lineNo: 2,
            description: "Mounting kit",
            quantity: "2",
            unit: "set",
            unitCost: "1000.00",
            lineTotal: "2000.00",
          },
        ],
      },
    },
  });
  supplierPoIds.push(po.id);
  return po;
}

afterAll(async () => {
  await db.supplierPOLine.deleteMany({ where: { supplierPOId: { in: supplierPoIds } } });
  await db.supplierPO.deleteMany({ where: { id: { in: supplierPoIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

describe("the purchase order document", () => {
  it("carries what a supplier needs to fulfil the order", async () => {
    const po = await makePo();
    const props = await buildSupplierPoPdfProps(po.id);

    expect(props.number).toBe(po.number);
    expect(props.supplier.name).toContain("Präzision");
    expect(props.supplier.contactName).toBe("Herr Vogel");
    expect(props.supplier.paymentTerms).toBe("30 days from invoice");
    expect(props.incoterm).toBe("FOB Hamburg");
    expect(props.lines).toHaveLength(2);
    expect(props.lines[0]!.modelNumber).toBe("PM-150-E");
    expect(props.lines[0]!.leadTimeDays).toBe(45);
  }, 60_000);

  it("writes every amount with its currency code", async () => {
    // Spec.md §6.6 forbids a bare number without its currency, and the document font has no peso
    // glyph, so the PDF writes the ISO code (docs/DECISIONS.md #31).
    const po = await makePo();
    const props = await buildSupplierPoPdfProps(po.id);

    expect(props.lines[0]!.unitCost).toMatch(/EUR/);
    expect(props.lines[0]!.lineTotal).toMatch(/EUR/);
    expect(props.currency).toBe("EUR");
  }, 60_000);

  it("prints the goods total, never the landed total", async () => {
    // Freight, duties and brokerage are AIES's cost of getting the goods here. They are not part of
    // what this supplier is owed, and printing them on their order invites a quote against a number
    // that is not theirs.
    const po = await makePo({ freight: "3000" });
    const props = await buildSupplierPoPdfProps(po.id);

    expect(props.subtotal).toBe("12000.00");
    expect(props.subtotal).not.toContain("15000");
  }, 60_000);

  it("does not carry the customer's name", async () => {
    // The same reasoning that keeps it off the RFQ: a supplier who learns whose job this is has
    // what they need to go around AIES.
    const po = await makePo();
    const props = await buildSupplierPoPdfProps(po.id);

    // The type has no field for it, which is the real guarantee; this asserts the shape has not
    // quietly grown one.
    expect(Object.keys(props)).not.toContain("customer");
    expect(JSON.stringify(props)).not.toMatch(/customer/i);
  }, 60_000);

  it("shows no approver until one has approved it", async () => {
    const po = await makePo();
    expect((await buildSupplierPoPdfProps(po.id)).approvedBy).toBeNull();
  }, 60_000);
});

describe("the draft email", () => {
  it("names the order, the items and what is wanted back", async () => {
    const po = await makePo();
    const text = await buildSupplierPoEmailText(po.id);

    expect(text).toContain("Dear Herr Vogel,");
    expect(text).toContain(po.number);
    expect(text).toContain("Electromagnetic flow meter DN150");
    // §5 tracks acknowledgement by hand, so the email has to ask for it.
    expect(text).toMatch(/acknowledge receipt/i);
    expect(text).toMatch(/packing list and invoice/i);
  }, 60_000);

  it("quotes the goods total, matching the document", async () => {
    const po = await makePo({ freight: "3000" });
    const text = await buildSupplierPoEmailText(po.id);

    expect(text).toMatch(/EUR\s*12,?000/);
    expect(text).not.toMatch(/15,?000/);
  }, 60_000);

  it("falls back to a neutral greeting when no contact is named", async () => {
    const po = await makePo();
    await db.supplier.update({ where: { id: po.supplierId }, data: { contactName: null } });

    expect(await buildSupplierPoEmailText(po.id)).toContain("Good day,");
  }, 60_000);
});
