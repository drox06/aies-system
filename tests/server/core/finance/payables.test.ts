import { describe, expect, it } from "vitest";
import {
  MATCH_TOLERANCE,
  payableAgeing,
  threeWayMatch,
  findingComparison,
} from "@/server/core/finance/payables-rules";

/**
 * §7's three-way match.
 *
 * §7 buys one thing and it is worth having: **are we about to pay for something we did not receive,
 * at a price we did not agree?** Each of the three documents is correct on its own; only the
 * comparison is wrong, which is why an overcharge survives being looked at.
 */
describe("PO against receipt against invoice", () => {
  const clean = { invoiceAmount: 100_000, orderTotal: 100_000, receivedValue: 100_000 };

  it("passes an invoice that agrees with both", () => {
    const result = threeWayMatch(clean);
    expect(result.matched).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("catches an invoice for more than was ordered", () => {
    const result = threeWayMatch({ ...clean, invoiceAmount: 112_000 });
    expect(result.matched).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain("price");
  });

  /**
   * The expensive one.
   *
   * Goods invoiced and never delivered are money out for nothing, and on a summary screen it looks
   * exactly like a price rise — which is why the two are separate findings with different words.
   */
  it("catches an invoice for more than was received", () => {
    const result = threeWayMatch({
      invoiceAmount: 100_000,
      orderTotal: 100_000,
      receivedValue: 60_000,
    });
    expect(result.findings.map((f) => f.kind)).toContain("quantity");
  });

  it("says plainly when nothing has been received at all", () => {
    const result = threeWayMatch({ invoiceAmount: 100_000, orderTotal: 100_000, receivedValue: 0 });
    expect(result.findings.map((f) => f.kind)).toContain("no_receipt");
  });

  /**
   * An invoice with no purchase order is how clause 8.4 gets bypassed after the fact.
   *
   * Reported rather than refused: the goods may genuinely have arrived and somebody has to be able
   * to record the liability. But it is never silent, and nothing else is compared — there is no
   * expectation to compare against, and inventing one would manufacture a second finding out of the
   * first.
   */
  it("reports an invoice with no order behind it, and compares nothing else", () => {
    const result = threeWayMatch({
      invoiceAmount: 50_000,
      orderTotal: null,
      receivedValue: null,
    });
    expect(result.matched).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe("no_order");
  });

  it("tolerates rounding but not a sum worth arguing about", () => {
    /*
      A peso. Rounding on a multi-line invoice legitimately lands a centavo or two out, and an ERP
      that disputes every invoice is one whose disputes stop meaning anything. Absolute rather than a
      percentage: 1% of a ₱2,000,000 order is ₱20,000, which somebody should have to explain.
    */
    expect(threeWayMatch({ ...clean, invoiceAmount: 100_000 + MATCH_TOLERANCE }).matched).toBe(
      true,
    );
    expect(
      threeWayMatch({ ...clean, invoiceAmount: 100_000 + MATCH_TOLERANCE + 0.5 }).matched,
    ).toBe(false);
  });
});

describe("how overdue a supplier invoice is", () => {
  const asOf = new Date("2026-08-20T09:00:00Z");
  const daysBefore = (n: number) => new Date(asOf.getTime() - n * 86_400_000);

  it("buckets by how far past the due date it is", () => {
    expect(payableAgeing(daysBefore(-5), asOf)).toBe("not_due");
    expect(payableAgeing(daysBefore(10), asOf)).toBe("1-30");
    expect(payableAgeing(daysBefore(45), asOf)).toBe("31-60");
    expect(payableAgeing(daysBefore(75), asOf)).toBe("61-90");
    expect(payableAgeing(daysBefore(200), asOf)).toBe("90+");
  });

  it("treats the due date itself as not yet late", () => {
    // Paying on the day is paying on time.
    expect(payableAgeing(asOf, asOf)).toBe("not_due");
  });

  /**
   * Absent is not late.
   *
   * A supplier may not have stated terms. Treating silence as a demand would put invoices at the top
   * of a chase list on no evidence — the same distinction as recorded N/A against unanswered.
   */
  it("does not call an invoice with no due date overdue", () => {
    expect(payableAgeing(null, asOf)).toBe("not_due");
  });
});

/**
 * The two figures behind a finding, which the screen threw away for a fortnight.
 *
 * `threeWayMatch` has stored `expected` and `actual` on every finding since the first commit, and
 * the payables screen rendered only `note` — so a `quantity` finding said "the invoice is for more
 * than has been received" without saying how much more, and somebody could not act on it without
 * going to work it out. docs/DECISIONS.md #134.
 *
 * These pin the labelling, because a generic *expected / actual* pair would be the same mistake as
 * summing the findings: technically true and useless on the telephone. "Ordered" and "Received and
 * accepted" are two different documents and two different people to ring.
 */
describe("the comparison behind a finding", () => {
  it("labels a price finding against the order", () => {
    const match = threeWayMatch({
      invoiceAmount: 461_000,
      orderTotal: 428_000,
      receivedValue: 461_000,
    });
    const price = match.findings.find((finding) => finding.kind === "price")!;
    const comparison = findingComparison(price)!;

    expect(comparison.expectedLabel).toBe("Ordered");
    expect(comparison.actualLabel).toBe("Invoiced");
    expect(comparison.difference).toBe(33_000);
  });

  it("labels a quantity finding against the goods receipt, and gives the amount to quote", () => {
    // PAY6's order B: two accumulators ordered at 75,000 each, one arrived, both billed.
    const match = threeWayMatch({
      invoiceAmount: 150_000,
      orderTotal: 150_000,
      receivedValue: 75_000,
    });
    const quantity = match.findings.find((finding) => finding.kind === "quantity")!;
    const comparison = findingComparison(quantity)!;

    expect(comparison.expectedLabel).toBe("Received and accepted");
    // The sentence a person says down the phone: 75,000 of goods billed that never arrived.
    expect(comparison.difference).toBe(75_000);
  });

  it("offers no comparison where none was made", () => {
    /*
      `no_receipt` and `no_order` have no expectation to compare against — printing "expected ₱0.00"
      would invent a comparison nobody performed, which is the same fault as a zero standing in for
      an absence everywhere else in this platform.
    */
    const noOrder = threeWayMatch({ invoiceAmount: 12_000, orderTotal: null, receivedValue: null });
    expect(findingComparison(noOrder.findings[0]!)).toBeNull();

    const noReceipt = threeWayMatch({
      invoiceAmount: 96_000,
      orderTotal: 96_000,
      receivedValue: 0,
    });
    const finding = noReceipt.findings.find((f) => f.kind === "no_receipt")!;
    expect(findingComparison(finding)).toBeNull();
  });
});
