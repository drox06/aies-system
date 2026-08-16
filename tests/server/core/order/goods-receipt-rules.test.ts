import { describe, expect, it } from "vitest";
import {
  checkReceiptLines,
  inspectionGate,
  procurementStatusFrom,
  receiptStatusFrom,
  supplierPoStatusFromReceipts,
} from "@/server/core/order/goods-receipt-rules";

/**
 * specs/03-order-procurement.md §6 and §11, as pure functions.
 *
 * §11 names one of these outright: "Partial receipt then partial delivery keeps
 * `qtyOrdered/Received/Delivered` consistent; **over-receipt and over-delivery are rejected**."
 */

const line = (overrides: Partial<Parameters<typeof checkReceiptLines>[0][number]> = {}) => ({
  supplierPOLineId: "l1",
  description: "Flow meter DN150",
  qtyOrdered: 5,
  qtyAlreadyReceived: 0,
  qtyReceived: 5,
  qtyAccepted: 5,
  qtyRejected: 0,
  ...overrides,
});

describe("§11: over-receipt is rejected", () => {
  it("accepts a delivery that matches the order", () => {
    expect(checkReceiptLines([line()]).ok).toBe(true);
  });

  it("accepts a partial delivery", () => {
    // The normal case, not the exception: a PO for five routinely arrives as three then two.
    expect(checkReceiptLines([line({ qtyReceived: 3, qtyAccepted: 3 })]).ok).toBe(true);
  });

  it("accepts the second half of a partial delivery", () => {
    const result = checkReceiptLines([
      line({ qtyAlreadyReceived: 3, qtyReceived: 2, qtyAccepted: 2 }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses more than was ordered", () => {
    const result = checkReceiptLines([line({ qtyReceived: 7, qtyAccepted: 7 })]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.message).toMatch(/at most 5 can still be booked in/);
  });

  it("refuses a delivery that would exceed the order once earlier ones are counted", () => {
    // The dangerous case, because each receipt looks fine on its own: three, then three, against
    // an order for five.
    const result = checkReceiptLines([
      line({ qtyAlreadyReceived: 3, qtyReceived: 3, qtyAccepted: 3 }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.message).toMatch(/at most 2 can still be booked in/);
    // And it names the likeliest cause, which is not the supplier over-shipping.
    expect(result.problems[0]!.message).toMatch(/do not enter it twice/);
  });

  it("tolerates a thousandth of a unit", () => {
    // Part-drums of cable and litres of oil. A check that fired here would cry wolf on every drum.
    expect(checkReceiptLines([line({ qtyReceived: 5.0001, qtyAccepted: 5.0001 })]).ok).toBe(true);
  });
});

describe("the accepted and rejected split", () => {
  it("refuses a split that does not add up to what arrived", () => {
    const result = checkReceiptLines([line({ qtyReceived: 5, qtyAccepted: 3, qtyRejected: 1 })]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.message).toMatch(/3 accepted plus 1 rejected is 4/);
  });

  it("accepts a split that does add up", () => {
    expect(checkReceiptLines([line({ qtyReceived: 5, qtyAccepted: 4, qtyRejected: 1 })]).ok).toBe(
      true,
    );
  });

  it("refuses negative quantities and says where a return belongs", () => {
    const result = checkReceiptLines([line({ qtyReceived: -2, qtyAccepted: -2 })]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.message).toMatch(/through the rejected column/);
  });

  it("reports every problem at once across several lines", () => {
    const result = checkReceiptLines([
      line({ supplierPOLineId: "a", qtyReceived: 9, qtyAccepted: 9 }),
      line({ supplierPOLineId: "b", description: "Gasket", qtyReceived: 5, qtyAccepted: 2 }),
    ]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems.map((problem) => problem.supplierPOLineId)).toEqual(["a", "b"]);
  });
});

describe("§6's incoming inspection, ISO 9001 clause 8.4.2", () => {
  const all = {
    quantityChecked: true,
    damageChecked: true,
    documentationChecked: true,
    photosAttached: true,
  };

  it("passes only when all four checks are done", () => {
    expect(inspectionGate(all).complete).toBe(true);
  });

  it("gives no partial credit for three out of four", () => {
    // An inspection that can be *mostly* done is one that is mostly not done, and the clause's
    // whole value is that "we checked" means something specific.
    const gate = inspectionGate({ ...all, documentationChecked: false });
    expect(gate.complete).toBe(false);
    expect(gate.missing).toEqual(["documentation check"]);
  });

  it("treats photographs as required, not as a nicety", () => {
    // They are the only part of the inspection that survives the person who did it: a damaged
    // crate nobody photographed is a dispute AIES loses.
    const gate = inspectionGate({ ...all, photosAttached: false });
    expect(gate.complete).toBe(false);
    expect(gate.missing).toEqual(["photographs"]);
  });

  it("lists everything outstanding, in §6's own words", () => {
    const gate = inspectionGate({
      quantityChecked: false,
      damageChecked: false,
      documentationChecked: false,
      photosAttached: false,
    });
    expect(gate.missing).toEqual([
      "quantity check",
      "damage check",
      "documentation check",
      "photographs",
    ]);
    expect(gate.message).toMatch(/clause\s+8\.4\.2/);
  });
});

describe("what a receipt becomes", () => {
  it("is accepted when nothing was rejected", () => {
    expect(receiptStatusFrom([{ qtyAccepted: 5, qtyRejected: 0 }])).toBe("accepted");
  });

  it("is rejected when nothing was accepted", () => {
    expect(receiptStatusFrom([{ qtyAccepted: 0, qtyRejected: 5 }])).toBe("rejected");
  });

  it("keeps partially_rejected as its own outcome", () => {
    // Nineteen good meters and one dented. It must not collapse either way: the nineteen advance
    // the customer's order and the one starts a conversation with the supplier.
    expect(receiptStatusFrom([{ qtyAccepted: 19, qtyRejected: 1 }])).toBe("partially_rejected");
  });
});

describe("what the supplier PO becomes", () => {
  it("is received only when every line is complete", () => {
    expect(
      supplierPoStatusFromReceipts(
        [
          { quantity: 5, qtyReceived: 5 },
          { quantity: 2, qtyReceived: 2 },
        ],
        "sent",
      ),
    ).toBe("received");
  });

  it("is partially_received when some has arrived", () => {
    expect(
      supplierPoStatusFromReceipts(
        [
          { quantity: 5, qtyReceived: 5 },
          { quantity: 2, qtyReceived: 0 },
        ],
        "sent",
      ),
    ).toBe("partially_received");
  });

  it("leaves the status alone when nothing has arrived", () => {
    expect(supplierPoStatusFromReceipts([{ quantity: 5, qtyReceived: 0 }], "acknowledged")).toBe(
      "acknowledged",
    );
  });
});

describe("§1's procurement workstream", () => {
  it("stays not_required when there is nothing to buy", () => {
    // "We received everything" and "there was nothing to receive" are different facts, and the
    // second should not read as progress.
    expect(procurementStatusFrom([])).toBe("not_required");
  });

  it("is received only when every live PO is", () => {
    expect(procurementStatusFrom(["received", "received"])).toBe("received");
    expect(procurementStatusFrom(["received", "sent"])).toBe("partially_received");
  });

  it("ignores cancelled POs", () => {
    // A cancelled order is not an outstanding one, and counting it would hold a sales order open
    // for goods nobody is waiting for.
    expect(procurementStatusFrom(["received", "cancelled"])).toBe("received");
    expect(procurementStatusFrom(["cancelled"])).toBe("not_required");
  });

  it("reports ordered once something is out with a supplier", () => {
    expect(procurementStatusFrom(["sent"])).toBe("ordered");
    expect(procurementStatusFrom(["draft"])).toBe("pending");
  });
});
