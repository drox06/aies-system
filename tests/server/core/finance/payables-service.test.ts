import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  approveSupplierInvoiceService,
  billableSuppliersService,
  payablesService,
  recordSupplierInvoiceService,
} from "@/server/core/finance/payables-service";

/**
 * §7's payables, through the services rather than the rules.
 *
 * ## Why this file exists
 *
 * `payables.test.ts` covers `threeWayMatch` and `payableAgeing` — both pure, both correct. Neither
 * touches a service, so nothing in the suite knew that `recordSupplierInvoiceService` **had no
 * caller at all** until the company tried to record a bill and found no form. docs/DECISIONS.md #133.
 *
 * A test cannot prove a screen exists. What it can do is pin the behaviour the screen depends on, so
 * the two halves are at least described in one place — and that is what these do:
 *
 *   - the match runs **at recording time** and its answer is stored, not re-derived
 *   - a repeated supplier reference is **refused**, because there is no legitimate version of it
 *   - a disputed bill cannot be cleared without somebody writing down what they checked
 *   - `billableSuppliers` offers only orders that have actually been placed
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `pay-${suffix}`, actorLabel: "Payables Test" };

const supplierIds: string[] = [];
const poIds: string[] = [];
const invoiceIds: string[] = [];

async function makeSupplier() {
  const supplier = await db.supplier.create({
    data: {
      code: `PAYT-${randomUUID().slice(0, 10)}`,
      name: `Payables Supply ${suffix}`,
      isApproved: true,
      approvedAt: new Date(),
    },
  });
  supplierIds.push(supplier.id);
  return supplier;
}

/** An order at a known value, received in full unless told otherwise. */
async function makeOrder(
  supplierId: string,
  opts: { total?: string; qtyReceived?: string; status?: string } = {},
) {
  const total = opts.total ?? "428000.00";
  const po = await db.supplierPO.create({
    data: {
      number: `PAYT-PO-${randomUUID().slice(0, 10)}`,
      supplierId,
      currency: "PHP",
      subtotal: total,
      total,
      status: opts.status ?? "received",
      sentAt: new Date(),
      createdById: actor.actorId,
      lines: {
        create: [
          {
            lineNo: 1,
            description: "Two control valves",
            quantity: "2",
            unit: "pc",
            unitCost: (Number(total) / 2).toFixed(2),
            lineTotal: total,
            qtyReceived: opts.qtyReceived ?? "2",
          },
        ],
      },
    },
  });
  poIds.push(po.id);
  return po;
}

async function record(
  supplierId: string,
  supplierPOId: string | null,
  amount: number,
  ref: string,
) {
  const created = await recordSupplierInvoiceService(actor, {
    supplierId,
    supplierPOId,
    supplierRef: ref,
    invoiceDate: new Date(),
    amount,
  });
  invoiceIds.push(created.id);
  return created;
}

afterAll(async () => {
  await db.supplierInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: invoiceIds } } });
  await db.supplierPOLine.deleteMany({ where: { supplierPOId: { in: poIds } } });
  await db.supplierPO.deleteMany({ where: { id: { in: poIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supplierIds } } });
});

describe("recording a bill", () => {
  it("matches one that agrees with the order and what was received", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);

    const created = await record(supplier.id, po.id, 428_000, `OK-${suffix}`);

    expect(created.match.matched).toBe(true);
    expect(created.match.findings).toEqual([]);
    expect(created.number).toMatch(/^AIESSB/);

    const saved = await db.supplierInvoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("matched");
  }, 60_000);

  it("disputes one that does not, and stores the finding rather than re-deriving it", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);

    const created = await record(supplier.id, po.id, 461_000, `HIGH-${suffix}`);

    expect(created.match.matched).toBe(false);
    expect(created.match.findings.map((f) => f.kind)).toContain("price");

    const saved = await db.supplierInvoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("disputed");

    /*
      Stored, and this is the assertion that matters.

      A finding is a fact about a moment. Amending the order afterwards must not quietly change what
      the company disputed — that is the thing somebody is telephoning the supplier about. So the
      order is moved underneath it and the finding has to stay put.
    */
    await db.supplierPO.update({ where: { id: po.id }, data: { total: "461000.00" } });

    const rows = await payablesService({});
    const mine = rows.rows.find((row) => row.id === created.id);
    expect(mine?.status).toBe("disputed");
    expect(mine?.findings.length).toBeGreaterThan(0);
  }, 60_000);

  it("flags a bill with no purchase order rather than refusing it", async () => {
    const supplier = await makeSupplier();

    // The goods may genuinely have arrived. But never silently — this is how a purchase clause 8.4
    // never approved gets into the accounts after the fact.
    const created = await record(supplier.id, null, 12_000, `NOPO-${suffix}`);

    expect(created.match.matched).toBe(false);
    expect(created.match.findings.map((f) => f.kind)).toContain("no_order");
  }, 60_000);

  it("refuses the same supplier reference twice", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);
    const ref = `DUP-${suffix}`;

    await record(supplier.id, po.id, 428_000, ref);

    /*
      Refused, not warned. Unlike a repeated export there is no legitimate version of this — a
      supplier billing the same reference twice is a statement chasing an invoice already sent, and
      the right action is always to go and find the existing record.
    */
    await expect(record(supplier.id, po.id, 428_000, ref)).rejects.toThrow(/already recorded/);
  }, 60_000);

  it("refuses an invoice for nothing, and one with no reference", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);

    await expect(record(supplier.id, po.id, 0, `ZERO-${suffix}`)).rejects.toThrow(/not an invoice/);
    await expect(record(supplier.id, po.id, 100, "   ")).rejects.toThrow(
      /Record the supplier's own invoice number/,
    );
  }, 60_000);
});

describe("clearing one for payment", () => {
  it("takes one press when it matched", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);
    const created = await record(supplier.id, po.id, 428_000, `CLEAR-${suffix}`);

    await approveSupplierInvoiceService(actor, { id: created.id });

    const saved = await db.supplierInvoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("approved");
    expect(saved.disputeOverrideReason).toBeNull();
  }, 60_000);

  it("demands what was checked when it did not", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);
    const created = await record(supplier.id, po.id, 461_000, `OVER-${suffix}`);

    await expect(
      approveSupplierInvoiceService(actor, { id: created.id, overrideReason: "ok" }),
    ).rejects.toThrow(/indistinguishable from nobody looking/);

    await approveSupplierInvoiceService(actor, {
      id: created.id,
      overrideReason: "Freight increase agreed by phone with Rosa on 18 August.",
    });

    const saved = await db.supplierInvoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("approved");
    // On the record, not only in the audit log — the payables row is where somebody looks.
    expect(saved.disputeOverrideReason).toContain("Rosa");
  }, 60_000);
});

describe("what a bill could be recorded against", () => {
  it("offers orders that have been placed, and not ones still in draft", async () => {
    const supplier = await makeSupplier();
    const placed = await makeOrder(supplier.id, { status: "sent" });
    const draft = await makeOrder(supplier.id, { status: "draft" });

    const rows = await billableSuppliersService();
    const mine = rows.find((row) => row.id === supplier.id);
    const offered = mine?.orders.map((order) => order.id) ?? [];

    expect(offered).toContain(placed.id);
    /*
      An order still in draft has not been placed with anybody, so no invoice can honestly answer
      it. Offering one would invite a bill against something nobody ordered — which is precisely
      what the three-way match exists to catch, arriving through the front door instead.
    */
    expect(offered).not.toContain(draft.id);
  }, 60_000);

  it("says how much has already been billed against an order", async () => {
    const supplier = await makeSupplier();
    const po = await makeOrder(supplier.id);
    await record(supplier.id, po.id, 200_000, `PART-${suffix}`);

    const rows = await billableSuppliersService();
    const mine = rows.find((row) => row.id === supplier.id);
    const order = mine?.orders.find((row) => row.id === po.id);

    /*
      §7 refuses a duplicate *reference*, which catches the commonest double payment. It cannot
      catch the same goods billed twice under two references — only a person can, and only if the
      screen tells them what the order already carries.
    */
    expect(Number(order?.alreadyBilled)).toBe(200_000);
  }, 60_000);
});
