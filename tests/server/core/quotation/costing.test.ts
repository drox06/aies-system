import { describe, expect, it } from "vitest";
import {
  computeCosting,
  discountForTargetTotal,
  fromCentavos,
  toCentavos,
  type CostingInput,
} from "@/server/core/quotation/costing";

/**
 * specs/02-quotation.md §12: "Margin maths across FX, markup, line discount, header discount, and
 * VAT modes — table-driven tests with fixed expected values."
 *
 * Every expected number below was worked out by hand and written as a literal. That is the point of
 * the exercise: a test that recomputes the answer with the same code it is testing proves only that
 * the function is deterministic. §1 calls this module "where margin is decided", so the arithmetic
 * is pinned to figures a person checked.
 */

interface Case {
  name: string;
  why: string;
  input: CostingInput;
  expect: {
    subtotal: number;
    discountAmount?: number;
    netAmount: number;
    vatAmount: number;
    total: number;
    totalCost: number;
    marginAmount: number;
    /** Margin percent, to four decimal places. */
    marginPct: number | null;
  };
}

const CASES: Case[] = [
  {
    name: "PHP cost, markup, VAT exclusive",
    why: "The base case. 2 × ₱1,000 cost at 25% markup = ₱2,500, cost ₱2,000, margin 20%.",
    input: {
      lines: [{ quantity: 2, unitCost: "1000.00", markupPct: 25 }],
    },
    expect: {
      subtotal: 250_000,
      netAmount: 250_000,
      vatAmount: 30_000,
      total: 280_000,
      totalCost: 200_000,
      marginAmount: 50_000,
      marginPct: 20,
    },
  },
  {
    name: "USD cost through FX and a 3% buffer",
    why:
      "§4's worked example. $100 at 58.5 with a 3% buffer lands at 60.255 → ₱6,025.50 cost; " +
      "20% markup → ₱7,230.60.",
    input: {
      lines: [{ quantity: 1, unitCost: "100.00", costFxRate: "58.5", markupPct: 20 }],
      fxBufferPct: 3,
    },
    expect: {
      subtotal: 723_060,
      netAmount: 723_060,
      vatAmount: 86_767, // round(723060 × 0.12) = round(86767.2)
      total: 809_827,
      totalCost: 602_550,
      marginAmount: 120_510,
      marginPct: 16.6667,
    },
  },
  {
    name: "direct price entry with a line discount",
    why:
      "§4: engineers think in price. markupPct null means the price was typed and the margin is " +
      "implied. 3 × ₱800 less 10% = ₱2,160 against ₱1,500 cost.",
    input: {
      lines: [
        {
          quantity: 3,
          unitCost: "500.00",
          markupPct: null,
          unitPrice: "800.00",
          lineDiscountPct: 10,
        },
      ],
      vatMode: "zero_rated",
    },
    expect: {
      subtotal: 216_000,
      netAmount: 216_000,
      vatAmount: 0,
      total: 216_000,
      totalCost: 150_000,
      marginAmount: 66_000,
      marginPct: 30.5556,
    },
  },
  {
    name: "optional lines are excluded from every total",
    why:
      "§7: optional lines appear on the document but never in the total — and must not move the " +
      "margin either, or quoting an alternate would change the deal's economics.",
    input: {
      lines: [
        { quantity: 1, unitCost: "1000.00", markupPct: 10 },
        { quantity: 1, unitCost: "500.00", markupPct: 10, isOptional: true },
      ],
      vatMode: "exempt",
    },
    expect: {
      subtotal: 110_000,
      netAmount: 110_000,
      vatAmount: 0,
      total: 110_000,
      totalCost: 100_000,
      marginAmount: 10_000,
      marginPct: 9.0909,
    },
  },
  {
    name: "header discount comes straight off margin",
    why:
      "§4: the header discount recomputes margin. Cost did not change because the customer " +
      "negotiated, so ₱250 off a ₱2,500 subtotal takes margin from ₱500 to ₱250.",
    input: {
      lines: [{ quantity: 2, unitCost: "1000.00", markupPct: 25 }],
      headerDiscount: "250.00",
    },
    expect: {
      subtotal: 250_000,
      discountAmount: 25_000,
      netAmount: 225_000,
      vatAmount: 27_000,
      total: 252_000,
      totalCost: 200_000,
      marginAmount: 25_000,
      marginPct: 11.1111,
    },
  },
  {
    name: "VAT inclusive backs the tax out of the stated price",
    why: "₱1,120 inclusive of 12% is ₱1,000 net and ₱120 VAT; the total does not move.",
    input: {
      lines: [{ quantity: 1, unitCost: "1000.00", markupPct: 12 }],
      vatMode: "inclusive",
    },
    expect: {
      subtotal: 112_000,
      netAmount: 112_000,
      vatAmount: 12_000,
      total: 112_000,
      totalCost: 100_000,
      marginAmount: 12_000,
      marginPct: 10.7143,
    },
  },
];

describe("computeCosting — §12's table", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const result = computeCosting(testCase.input);

      expect(result.subtotal, "subtotal").toBe(testCase.expect.subtotal);
      if (testCase.expect.discountAmount !== undefined) {
        expect(result.discountAmount, "discount").toBe(testCase.expect.discountAmount);
      }
      expect(result.netAmount, "net").toBe(testCase.expect.netAmount);
      expect(result.vatAmount, "VAT").toBe(testCase.expect.vatAmount);
      expect(result.total, "total").toBe(testCase.expect.total);
      expect(result.totalCost, "cost").toBe(testCase.expect.totalCost);
      expect(result.marginAmount, "margin").toBe(testCase.expect.marginAmount);

      if (testCase.expect.marginPct === null) {
        expect(result.marginPct).toBeNull();
      } else {
        expect(result.marginPct, "margin %").toBeCloseTo(testCase.expect.marginPct, 4);
      }
    });
  }
});

describe("money never passes through a float", () => {
  it("parses a decimal string exactly, including the classic 0.1 + 0.2 case", () => {
    expect(toCentavos("0.10") + toCentavos("0.20")).toBe(30);
    expect(fromCentavos(toCentavos("0.10") + toCentavos("0.20"))).toBe("0.30");
  });

  it("rounds a third decimal place half up rather than truncating", () => {
    expect(toCentavos("1234.567")).toBe(123_457);
    expect(toCentavos("1234.564")).toBe(123_456);
    expect(toCentavos("1234.565")).toBe(123_457);
  });

  it("survives forty lines without drifting", () => {
    // The failure this design exists to prevent: a total ending .99999998 on a signed document.
    const lines = Array.from({ length: 40 }, () => ({
      quantity: 1,
      unitCost: "0.10",
      markupPct: 0,
    }));
    const result = computeCosting({ lines, vatMode: "zero_rated" });
    expect(result.subtotal).toBe(400);
    expect(fromCentavos(result.total)).toBe("4.00");
  });

  it("round-trips through the wire format", () => {
    for (const value of ["0.00", "0.01", "1234.56", "-42.07", "999999.99"]) {
      expect(fromCentavos(toCentavos(value))).toBe(value);
    }
  });

  it("refuses an amount too large to represent exactly", () => {
    expect(() =>
      computeCosting({ lines: [{ quantity: 1e15, unitCost: "1000.00", markupPct: 0 }] }),
    ).toThrow(/too large to represent exactly/);
  });
});

describe("guards", () => {
  it("will not discount a quotation below zero", () => {
    const result = computeCosting({
      lines: [{ quantity: 1, unitCost: "100.00", markupPct: 0 }],
      headerDiscount: "5000.00",
      vatMode: "zero_rated",
    });
    // A negative total is not a quotation.
    expect(result.discountAmount).toBe(10_000);
    expect(result.netAmount).toBe(0);
    expect(result.total).toBe(0);
  });

  it("reports a null margin percent rather than a misleading zero on an empty quote", () => {
    const result = computeCosting({ lines: [] });
    expect(result.marginPct).toBeNull();
    expect(result.total).toBe(0);
  });

  it("flags lines below the margin floor without blocking them", () => {
    // §11 has `quotation.override_margin_floor`, so the engine reports and the service decides.
    const result = computeCosting({
      lines: [
        { quantity: 1, unitCost: "1000.00", markupPct: 30 }, // ~23% margin
        { quantity: 1, unitCost: "1000.00", markupPct: 2 }, // ~1.96% margin
        { quantity: 1, unitCost: "1000.00", markupPct: 1, isOptional: true },
      ],
      marginFloorPct: 15,
    });
    expect(result.linesBelowFloor).toEqual([1]);
  });

  it("rejects an FX rate of zero rather than dividing the company's margin by nothing", () => {
    expect(() =>
      computeCosting({
        lines: [{ quantity: 1, unitCost: "100.00", costFxRate: 0, markupPct: 10 }],
      }),
    ).toThrow(/Not an FX rate/);
  });
});

describe("discountForTargetTotal — §8's what-if", () => {
  it("finds the discount that hits a target total, and agrees with computeCosting", () => {
    const input: CostingInput = { lines: [{ quantity: 2, unitCost: "1000.00", markupPct: 25 }] };

    // ₱2,520.00 inclusive of 12% VAT is ₱2,250 net — a ₱250 discount off the ₱2,500 subtotal.
    const { discountAmount, result } = discountForTargetTotal(input, "2520.00");
    expect(discountAmount).toBe(25_000);
    expect(result.total).toBe(252_000);
    // The whole point of returning a discount rather than a total: it goes back through the same
    // arithmetic, so the builder and the stored record cannot disagree.
    expect(result.marginAmount).toBe(25_000);
  });

  it("asks for no discount when the target is already met", () => {
    const input: CostingInput = { lines: [{ quantity: 2, unitCost: "1000.00", markupPct: 25 }] };
    expect(discountForTargetTotal(input, "2800.00").discountAmount).toBe(0);
  });
});

describe("§4: a header discount distributes across the lines", () => {
  it("takes each line's share without touching the amount the customer sees", () => {
    // Two lines, 1,000 and 3,000, with a 400 header discount: 100 off the first, 300 off the second.
    const result = computeCosting({
      lines: [
        { quantity: "1", unitCost: "500", unitPrice: "1000" },
        { quantity: "1", unitCost: "1500", unitPrice: "3000" },
      ],
      headerDiscount: "400",
      vatMode: "zero_rated",
    });

    // The **printed** line amounts stay at full price. A document that reduced these *and* printed
    // a discount row would show one reduction twice, and the amounts would not sum to the subtotal
    // above them.
    expect(fromCentavos(result.lines[0]!.lineTotal)).toBe("1000.00");
    expect(fromCentavos(result.lines[1]!.lineTotal)).toBe("3000.00");
    // The share is carried separately, and it is what margin is computed from.
    expect(fromCentavos(result.lines[0]!.discountShare)).toBe("100.00");
    expect(fromCentavos(result.lines[1]!.discountShare)).toBe("300.00");
    expect(fromCentavos(result.lines[0]!.lineMargin)).toBe("400.00"); // 1,000 − 100 − 500
    expect(fromCentavos(result.lines[1]!.lineMargin)).toBe("1200.00"); // 3,000 − 300 − 1,500

    // The header figures are unchanged: subtotal at full price, then the discount, then the net.
    expect(fromCentavos(result.subtotal)).toBe("4000.00");
    expect(fromCentavos(result.discountAmount)).toBe("400.00");
    expect(fromCentavos(result.total)).toBe("3600.00");
    expect(fromCentavos(result.marginAmount)).toBe("1600.00");
  });

  it("keeps the printed line amounts summing to the printed subtotal", () => {
    // The property the customer actually checks with a calculator.
    const result = computeCosting({
      lines: [
        { quantity: "2", unitCost: "100", unitPrice: "250" },
        { quantity: "3", unitCost: "40", unitPrice: "90" },
      ],
      headerDiscount: "77",
      vatMode: "zero_rated",
    });

    const printed = result.lines.reduce((sum, line) => sum + line.lineTotal, 0);
    expect(fromCentavos(printed)).toBe(fromCentavos(result.subtotal));
  });

  it("makes the floor warning tell the truth about a discounted quotation", () => {
    // The reason this matters. At list price the line clears the 15% floor comfortably; after a
    // heavy header discount it does not, and before this the warning stayed silent.
    const atList = computeCosting({
      lines: [{ quantity: "1", unitCost: "850", unitPrice: "1000" }],
      headerDiscount: "0",
      vatMode: "zero_rated",
      marginFloorPct: 15,
    });
    expect(atList.linesBelowFloor).toEqual([]);

    const discounted = computeCosting({
      lines: [{ quantity: "1", unitCost: "850", unitPrice: "1000" }],
      headerDiscount: "100",
      vatMode: "zero_rated",
      marginFloorPct: 15,
    });
    expect(discounted.linesBelowFloor).toEqual([0]);
  });

  it("leaves an optional line alone, since it is not in the subtotal", () => {
    const result = computeCosting({
      lines: [
        { quantity: "1", unitCost: "500", unitPrice: "1000" },
        { quantity: "1", unitCost: "100", unitPrice: "500", isOptional: true },
      ],
      headerDiscount: "100",
      vatMode: "zero_rated",
    });

    // Neither amount moves; only the counted line carries a share.
    expect(fromCentavos(result.lines[0]!.lineTotal)).toBe("1000.00");
    expect(fromCentavos(result.lines[0]!.discountShare)).toBe("100.00");
    expect(fromCentavos(result.lines[1]!.lineTotal)).toBe("500.00");
    expect(fromCentavos(result.lines[1]!.discountShare)).toBe("0.00");
  });

  it("gives the rounding remainder to the largest line, so the parts sum exactly", () => {
    // Three equal lines and a discount that does not divide by three.
    const result = computeCosting({
      lines: [
        { quantity: "1", unitCost: "0", unitPrice: "100" },
        { quantity: "1", unitCost: "0", unitPrice: "100" },
        { quantity: "1", unitCost: "0", unitPrice: "100" },
      ],
      headerDiscount: "10",
      vatMode: "zero_rated",
    });

    const shares = result.lines.reduce((sum, line) => sum + line.discountShare, 0);
    expect(fromCentavos(shares)).toBe("10.00");
    expect(fromCentavos(result.subtotal - result.discountAmount)).toBe("290.00");
  });
});
