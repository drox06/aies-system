import { describe, expect, it } from "vitest";
import {
  ITEM_TYPES,
  SOURCES,
  awaitsPurchase,
  calibrationCheck,
  custodyOutstandingQty,
  issuableQuantity,
  issueStateOf,
  materialGate,
  outstandingCustody,
  purchaseLines,
} from "@/server/core/operations/material-request-rules";

/**
 * specs/04-operations-projects.md §7, as pure functions.
 *
 * Two assertions carry the section. The gate has to treat "nobody answered" as different from "the
 * answer was no" — §7: "`N/A` is a legitimate, recorded answer, not a skipped step." And drawing an
 * out-of-calibration instrument has to be **blocked**, not warned about, which is the one place this
 * build prefers a refusal to a note.
 */

describe("§7's vocabulary", () => {
  it("is the six item types and four sources the spec names", () => {
    expect([...ITEM_TYPES]).toEqual([
      "consumable",
      "spare_part",
      "tool",
      "instrument",
      "ppe",
      "rental",
    ]);
    expect([...SOURCES]).toEqual(["stock", "purchase", "customer_supplied", "rental"]);
  });
});

describe("§1's Gate 2 — the Y / N/A / N diamond", () => {
  /**
   * The state most systems lose.
   *
   * A ticket nobody has thought about looks exactly like a ticket that needs nothing, and the
   * difference between them is a crew standing in a store room at seven in the morning.
   */
  it("blocks a ticket nobody has answered, and says so", () => {
    const gate = materialGate({ materialRequestStatus: "required" }, []);
    expect(gate.state).toBe("undecided");
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/not the same as a no/);
  });

  it("clears when somebody recorded that none are needed", () => {
    const gate = materialGate({ materialRequestStatus: "not_applicable" }, []);
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);
  });

  it("clears when the materials have been issued", () => {
    const gate = materialGate({ materialRequestStatus: "issued" }, [{ status: "issued" }]);
    expect(gate.blocks).toBe(false);
  });

  it("blocks on a partial issue — what is missing is what the crew finds on site", () => {
    const gate = materialGate({ materialRequestStatus: "partial" }, [
      { status: "partially_issued" },
    ]);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/discover on site/);
  });

  it("blocks while something is on order", () => {
    const gate = materialGate({ materialRequestStatus: "requested" }, [{ status: "purchased" }]);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/on order/);
  });

  it("ignores cancelled and refused requests when deciding", () => {
    const gate = materialGate({ materialRequestStatus: "required" }, [
      { status: "cancelled" },
      { status: "rejected" },
    ]);
    // Back to undecided rather than blocked-with-a-request: nothing live means nobody has answered.
    expect(gate.state).toBe("undecided");
  });
});

describe("§7's calibration block", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");

  it("does not interfere with anything that is not an instrument", () => {
    expect(
      calibrationCheck({ name: "Gasket", calibrationDueAt: null }, "consumable", now).blocked,
    ).toBe(false);
  });

  it("blocks an instrument whose calibration has lapsed", () => {
    const check = calibrationCheck(
      { name: "Fluke 754", calibrationDueAt: new Date("2026-08-01T00:00:00.000Z") },
      "instrument",
      now,
    );
    expect(check.blocked).toBe(true);
    expect(check.message).toMatch(/out of calibration/);
  });

  it("allows one that is still in date", () => {
    expect(
      calibrationCheck(
        { name: "Fluke 754", calibrationDueAt: new Date("2026-12-01T00:00:00.000Z") },
        "instrument",
        now,
      ).blocked,
    ).toBe(false);
  });

  /**
   * Unknown is not the same as fine.
   *
   * A measurement from an instrument with no calibration record has no standing either — and it ends
   * up on a service report the customer keeps.
   */
  it("blocks an instrument with no calibration date at all", () => {
    const check = calibrationCheck(
      { name: "Old clamp meter", calibrationDueAt: null },
      "instrument",
      now,
    );
    expect(check.blocked).toBe(true);
    expect(check.message).toMatch(/no calibration due date/);
  });
});

describe("issuing", () => {
  it("reports how much of a line is left", () => {
    expect(issuableQuantity({ quantity: 5, qtyIssued: 2 })).toBe(3);
    expect(issuableQuantity({ quantity: 5, qtyIssued: 5 })).toBe(0);
    // Never negative, so an over-issue cannot make the next one look available.
    expect(issuableQuantity({ quantity: 5, qtyIssued: 7 })).toBe(0);
  });

  it("calls a request issued only when every line is", () => {
    expect(
      issueStateOf([
        { lineNo: 1, quantity: 2, qtyIssued: 2 },
        { lineNo: 2, quantity: 3, qtyIssued: 3 },
      ]),
    ).toBe("issued");
    expect(
      issueStateOf([
        { lineNo: 1, quantity: 2, qtyIssued: 2 },
        { lineNo: 2, quantity: 3, qtyIssued: 0 },
      ]),
    ).toBe("partially_issued");
    expect(issueStateOf([{ lineNo: 1, quantity: 2, qtyIssued: 0 }])).toBe("approved");
  });
});

describe("§7's custody list", () => {
  const lines = [
    {
      itemType: "tool",
      description: "Torque wrench",
      qtyIssued: 1,
      qtyReturned: 0,
      qtyConsumed: 0,
    },
    { itemType: "instrument", description: "Fluke", qtyIssued: 1, qtyReturned: 1, qtyConsumed: 0 },
    {
      itemType: "consumable",
      description: "Sealant",
      qtyIssued: 4,
      qtyReturned: 0,
      qtyConsumed: 0,
    },
  ];

  /**
   * §7: "Unreturned tools appear on an outstanding-custody list per technician. Tools disappear
   * otherwise; this is universal."
   */
  it("lists the tool that has not come back", () => {
    const out = outstandingCustody(lines);
    expect(out.map((line) => line.description)).toEqual(["Torque wrench"]);
  });

  /**
   * Consumables are excluded by construction. A tube of sealant that went to site is not coming
   * back, and chasing it would train people to ignore the list.
   */
  it("does not chase consumables", () => {
    expect(outstandingCustody(lines).some((line) => line.itemType === "consumable")).toBe(false);
  });

  it("counts what is still out, net of returns and consumption", () => {
    expect(
      custodyOutstandingQty({
        itemType: "tool",
        description: "",
        qtyIssued: 5,
        qtyReturned: 2,
        qtyConsumed: 1,
      }),
    ).toBe(2);
  });
});

describe("§7's fan-out to module 03", () => {
  const lines = [
    { source: "stock", status: "pending", description: "Gasket" },
    { source: "purchase", status: "pending", description: "Special seal" },
    { source: "customer_supplied", status: "pending", description: "Flange" },
  ];

  it("picks out only what has to be bought", () => {
    expect(purchaseLines(lines).map((line) => line.description)).toEqual(["Special seal"]);
  });

  /** §7: "The ticket sits at `material_pending` until resolved." */
  it("knows the request is still waiting on a purchase", () => {
    expect(awaitsPurchase(lines)).toBe(true);
    expect(
      awaitsPurchase([
        { source: "purchase", status: "issued" },
        { source: "stock", status: "pending" },
      ]),
    ).toBe(false);
  });
});
