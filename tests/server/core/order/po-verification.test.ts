import { describe, expect, it } from "vitest";
import {
  checkCustomerPoAgainstQuotation,
  summariseCheck,
  type PoCheckInput,
} from "@/server/core/order/po-verification";

/**
 * specs/03-order-procurement.md §3's three-way check.
 *
 * The spec singles this function out — "**This single check prevents the most expensive category of
 * error in this business**" — so it gets tests that name the errors rather than tests that name the
 * branches. Pure, so no database: that is the point of keeping it out of the service.
 */

function quotation(lines: { lineNo: number; description: string; quantity: number }[] = []) {
  return {
    number: "AIESLQ260001",
    total: 100_000,
    currency: "PHP",
    lines,
  };
}

function input(
  overrides: {
    quotation?: Partial<PoCheckInput["quotation"]>;
    po?: Partial<PoCheckInput["po"]>;
  } = {},
): PoCheckInput {
  return {
    quotation: { ...quotation(), ...overrides.quotation },
    po: { poNumber: "PO-9001", amount: 100_000, currency: "PHP", ...overrides.po },
  };
}

describe("the documents agree", () => {
  it("finds nothing when the amount and currency match and no lines were typed", () => {
    const result = checkCustomerPoAgainstQuotation(input());

    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
    // And says so, rather than letting a clean result imply the quantities were looked at.
    expect(result.quantitiesChecked).toBe(false);
    expect(summariseCheck(result)).toMatch(/Line quantities were not captured/);
  });

  it("ignores a rounding difference of half a centavo", () => {
    // Decimal(14,2) round-trips through `Number()` on the way in. A check that fired on the seventh
    // decimal place would cry wolf on every document and teach people to click past it.
    const result = checkCustomerPoAgainstQuotation(input({ po: { amount: 100_000.004 } }));

    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes a full line-for-line match", () => {
    const lines = [
      { lineNo: 1, description: "Flow meter DN150", quantity: 4 },
      { lineNo: 2, description: "Installation", quantity: 1 },
    ];
    const result = checkCustomerPoAgainstQuotation(input({ quotation: { lines }, po: { lines } }));

    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.quantitiesChecked).toBe(true);
    expect(summariseCheck(result)).toMatch(/every line/);
  });
});

describe("currency", () => {
  it("blocks, and does not report anything else", () => {
    // 100,000 USD against 100,000 PHP is not a rounding difference. Reporting it as an amount
    // mismatch would send somebody looking for a discount that does not exist.
    const result = checkCustomerPoAgainstQuotation(
      input({
        po: {
          currency: "USD",
          amount: 2_000,
          lines: [{ lineNo: 9, description: "X", quantity: 1 }],
        },
        quotation: { lines: [{ lineNo: 1, description: "Y", quantity: 1 }] },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.kind).toBe("currency");
    expect(result.discrepancies[0]!.severity).toBe("blocking");
    // The extra line is real and is not mentioned: nothing was compared past the currency, and the
    // message says so.
    expect(result.discrepancies[0]!.message).toMatch(/Nothing else on this page has been compared/);
    expect(result.quantitiesChecked).toBe(false);
  });
});

describe("amount", () => {
  it("reports a shortfall as advisory, so somebody can accept a partial order", () => {
    const result = checkCustomerPoAgainstQuotation(input({ po: { amount: 60_000 } }));

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.kind).toBe("amount");
    expect(result.discrepancies[0]!.severity).toBe("advisory");
    expect(result.discrepancies[0]!.message).toMatch(/short by 40000\.00/);
    // Advisory means the sales order is not blocked — §3 asks for the difference to be *surfaced*,
    // and a customer ordering part of a scope is an ordinary commercial decision.
    expect(result.ok).toBe(true);
  });

  it("reports an overage the other way round", () => {
    const result = checkCustomerPoAgainstQuotation(input({ po: { amount: 130_000 } }));

    expect(result.discrepancies[0]!.message).toMatch(/over by 30000\.00/);
  });
});

describe("line quantities", () => {
  const quoted = [
    { lineNo: 1, description: "Flow meter DN150", quantity: 5 },
    { lineNo: 2, description: "Gaskets", quantity: 10 },
  ];

  it("catches four ordered against five quoted — the error §3 is written for", () => {
    const result = checkCustomerPoAgainstQuotation(
      input({
        quotation: { lines: quoted },
        po: {
          lines: [
            { lineNo: 1, description: "Flow meter DN150", quantity: 4 },
            { lineNo: 2, description: "Gaskets", quantity: 10 },
          ],
        },
      }),
    );

    const quantity = result.discrepancies.filter((d) => d.kind === "quantity");
    expect(quantity).toHaveLength(1);
    expect(quantity[0]!.lineNo).toBe(1);
    expect(quantity[0]!.message).toMatch(/quoted 5, ordered 4/);
    expect(result.quantitiesChecked).toBe(true);
  });

  it("says so when more was ordered than quoted, because the unit price may not hold", () => {
    const result = checkCustomerPoAgainstQuotation(
      input({
        quotation: { lines: quoted },
        po: {
          lines: [
            { lineNo: 1, description: "Flow meter DN150", quantity: 12 },
            { lineNo: 2, description: "Gaskets", quantity: 10 },
          ],
        },
      }),
    );

    const quantity = result.discrepancies.find((d) => d.kind === "quantity");
    expect(quantity?.message).toMatch(/price per unit may no longer hold/);
  });

  it("reports a quoted line the customer did not order, without blocking", () => {
    const result = checkCustomerPoAgainstQuotation(
      input({
        quotation: { lines: quoted },
        po: { lines: [{ lineNo: 1, description: "Flow meter DN150", quantity: 5 }] },
      }),
    );

    const missing = result.discrepancies.filter((d) => d.kind === "missing_line");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.lineNo).toBe(2);
    expect(missing[0]!.severity).toBe("advisory");
    expect(result.ok).toBe(true);
  });

  it("blocks on a line that was never quoted", () => {
    // The one line-level finding that stops the sales order: an item with no agreed price and no
    // costed supply. Proceeding means committing to deliver something nobody has priced.
    const result = checkCustomerPoAgainstQuotation(
      input({
        quotation: { lines: quoted },
        po: {
          lines: [...quoted, { lineNo: 3, description: "Spare impeller", quantity: 2 }],
        },
      }),
    );

    const extra = result.discrepancies.filter((d) => d.kind === "extra_line");
    expect(extra).toHaveLength(1);
    expect(extra[0]!.lineNo).toBe(3);
    expect(extra[0]!.severity).toBe("blocking");
    expect(result.ok).toBe(false);
  });

  it("tolerates a thousandth of a unit", () => {
    const result = checkCustomerPoAgainstQuotation(
      input({
        quotation: { lines: [{ lineNo: 1, description: "Cable", quantity: 12.5 }] },
        po: { lines: [{ lineNo: 1, description: "Cable", quantity: 12.5001 }] },
      }),
    );

    expect(result.discrepancies).toEqual([]);
  });

  it("reports every difference at once rather than the first", () => {
    // Somebody resolving these wants the whole list: a check that reveals one problem at a time
    // turns a single conversation with the customer into three.
    const result = checkCustomerPoAgainstQuotation(
      input({
        po: {
          amount: 80_000,
          lines: [
            { lineNo: 1, description: "Flow meter DN150", quantity: 3 },
            { lineNo: 4, description: "Unquoted extra", quantity: 1 },
          ],
        },
        quotation: { lines: quoted },
      }),
    );

    expect(result.discrepancies.map((d) => d.kind).sort()).toEqual([
      "amount",
      "extra_line",
      "missing_line",
      "quantity",
    ]);
    expect(result.ok).toBe(false);
    expect(summariseCheck(result)).toBe(
      "4 difference(s) from the quotation: 1 that must be resolved, 3 to confirm.",
    );
  });
});
