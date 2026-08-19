import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION,
  COVERAGE,
  checkClaim,
  determine,
  expiringWithin,
  readCoverage,
  warrantySummary,
} from "@/server/core/operations/warranty-rules";

/**
 * specs/04-operations-projects.md §11, as pure functions.
 *
 * §20 names the tests this section owes: "**Warranty gate:** in-warranty raises a non-billable
 * ticket linked to the original project; out-of-warranty routes to sales; AIES-caused raises an NCR."
 */

const on = (iso: string) => new Date(iso);

describe("§11's vocabulary", () => {
  it("keeps coverage and attribution as two separate questions", () => {
    expect([...COVERAGE]).toEqual(["in_warranty", "out_of_warranty", "unknown"]);
    expect([...ATTRIBUTION]).toEqual([
      "aies_caused",
      "customer_caused",
      "third_party",
      "undetermined",
    ]);
  });
});

describe("reading the warranty window", () => {
  const equipment = {
    warrantyStart: "2026-01-01T00:00:00.000Z",
    warrantyEnd: "2026-12-31T00:00:00.000Z",
  };

  it("covers a fault inside the window", () => {
    const reading = readCoverage(equipment, on("2026-06-01T00:00:00.000Z"));
    expect(reading.coverage).toBe("in_warranty");
    expect(reading.daysRemaining).toBeGreaterThan(0);
  });

  /** Claims arrive on the last day. Treating the end date as exclusive would deny them. */
  it("covers the whole of the last day", () => {
    expect(readCoverage(equipment, on("2026-12-31T23:59:00.000Z")).coverage).toBe("in_warranty");
  });

  it("reports a fault after the window as out of warranty", () => {
    const reading = readCoverage(equipment, on("2027-02-01T00:00:00.000Z"));
    expect(reading.coverage).toBe("out_of_warranty");
    expect(reading.reason).toMatch(/window closed/);
  });

  /**
   * The rule the section turns on. Defaulting a missing window to expired bills a customer for
   * something possibly covered; defaulting it to covered gives work away. Both are the software
   * answering a commercial question it cannot answer.
   */
  it("calls a missing end date unknown rather than expired", () => {
    const reading = readCoverage({ warrantyStart: "2026-01-01T00:00:00.000Z", warrantyEnd: null });
    expect(reading.coverage).toBe("unknown");
    expect(reading.reason).toMatch(/not the same as expired/);
  });

  it("has no window at all without an equipment record", () => {
    expect(readCoverage(null).coverage).toBe("unknown");
  });

  it("flags a fault reported before the warranty was due to start", () => {
    const reading = readCoverage(equipment, on("2025-06-01T00:00:00.000Z"));
    expect(reading.coverage).toBe("unknown");
    expect(reading.reason).toMatch(/before the warranty was due to start/);
  });
});

describe("§11's determination", () => {
  /** §20: in-warranty raises a non-billable ticket. */
  it("makes an in-warranty claim non-billable and raises the ticket", () => {
    const verdict = determine({ coverage: "in_warranty", attribution: "undetermined" });
    expect(verdict.billable).toBe(false);
    expect(verdict.raisesTicket).toBe(true);
    expect(verdict.route).toBe("warranty_ticket");
  });

  /** §20: out-of-warranty routes to sales. */
  it("routes an out-of-warranty customer-caused fault to sales", () => {
    const verdict = determine({ coverage: "out_of_warranty", attribution: "customer_caused" });
    expect(verdict.billable).toBe(true);
    expect(verdict.referToSales).toBe(true);
    expect(verdict.raisesTicket).toBe(false);
    expect(verdict.route).toBe("sales_quote");
  });

  /** §20: AIES-caused raises an NCR. */
  it("makes an AIES-caused defect non-billable and raises an NCR", () => {
    const verdict = determine({ coverage: "in_warranty", attribution: "aies_caused" });
    expect(verdict.billable).toBe(false);
    expect(verdict.ncrRequired).toBe(true);
  });

  /**
   * The case a single three-valued enum would have lost, and the reason coverage and attribution are
   * separate axes: a company that installed something badly does not get to charge for fixing it
   * because thirteen months have passed.
   */
  it("keeps an AIES-caused defect non-billable after the warranty has expired", () => {
    const verdict = determine({ coverage: "out_of_warranty", attribution: "aies_caused" });
    expect(verdict.billable).toBe(false);
    expect(verdict.ncrRequired).toBe(true);
    expect(verdict.referToSales).toBe(false);
    expect(verdict.reason).toMatch(/window does not excuse/);
  });

  it("refuses to route a claim with no warranty window recorded", () => {
    const verdict = determine({ coverage: "unknown", attribution: "undetermined" });
    expect(verdict.route).toBe("needs_determination");
    expect(verdict.raisesTicket).toBe(false);
    expect(verdict.referToSales).toBe(false);
  });

  /** Quoting before the cause is known risks charging for the company's own defect. */
  it("does not send an out-of-warranty claim to sales while the cause is unknown", () => {
    const verdict = determine({ coverage: "out_of_warranty", attribution: "undetermined" });
    expect(verdict.route).toBe("needs_determination");
    expect(verdict.billable).toBe(false);
  });
});

describe("§11's claim checks", () => {
  const base = {
    faultDescription: "Transmitter reads zero on start-up",
    coverage: "in_warranty" as const,
    attribution: "undetermined" as const,
  };

  it("accepts a described fault", () => {
    expect(checkClaim(base).ok).toBe(true);
  });

  it("refuses a claim with no fault described", () => {
    const check = checkClaim({ ...base, faultDescription: "  " });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs the fault described/);
  });

  /** A person may overrule the dates. What they may not do is overrule them silently. */
  it("refuses an unexplained override of what the dates say", () => {
    const check = checkClaim({
      ...base,
      coverage: "in_warranty",
      readingCoverage: "out_of_warranty",
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/an override nobody explains/);
  });

  it("accepts an override that is explained", () => {
    const check = checkClaim({
      ...base,
      coverage: "in_warranty",
      readingCoverage: "out_of_warranty",
      coverageOverrideReason: "Goodwill repair agreed by the VP; unit was down for six weeks.",
    });
    expect(check.ok).toBe(true);
  });

  /** §11 reports warranty cost by cause. "Ours" with no cause tells nobody what to stop doing. */
  it("refuses an AIES-caused claim with no root cause category", () => {
    const check = checkClaim({ ...base, attribution: "aies_caused" });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs a root cause category/);
  });

  it("accepts an AIES-caused claim with one", () => {
    const check = checkClaim({
      ...base,
      attribution: "aies_caused",
      rootCauseCategory: "installation_workmanship",
    });
    expect(check.ok).toBe(true);
  });

  it("warns when there is no warranty window to work from", () => {
    const check = checkClaim({ ...base, coverage: "unknown" });
    expect(check.warnings.join(" ")).toMatch(/Recording the terms now/);
  });
});

describe("§11's reporting", () => {
  const records = [
    {
      attribution: "aies_caused" as const,
      coverage: "in_warranty" as const,
      rootCauseCategory: "installation_workmanship",
      billable: false,
      modelNumber: "TX-100",
      cost: 5000,
    },
    {
      attribution: "aies_caused" as const,
      coverage: "out_of_warranty" as const,
      rootCauseCategory: "installation_workmanship",
      billable: false,
      modelNumber: "TX-100",
      cost: 3000,
    },
    {
      attribution: "customer_caused" as const,
      coverage: "out_of_warranty" as const,
      rootCauseCategory: "operator_error",
      billable: true,
      modelNumber: "VLV-20",
      cost: 1000,
    },
  ];

  /**
   * §11: "Warranty cost that nobody totals is warranty cost that never gets fixed." The AIES-caused
   * subtotal is the part the company could have avoided, and the part that disappears if warranty
   * work is only ever counted in total.
   */
  it("separates what the company caused from what it merely carried", () => {
    const summary = warrantySummary(records);
    expect(summary.total).toBe(3);
    expect(summary.totalCost).toBe(9000);
    expect(summary.aiesCausedCount).toBe(2);
    expect(summary.aiesCausedCost).toBe(8000);
    expect(summary.aiesCausedPct).toBeCloseTo(66.7, 1);
  });

  it("groups by cause and by product, worst first", () => {
    const summary = warrantySummary(records);
    expect(summary.byCause[0]!.category).toBe("installation_workmanship");
    expect(summary.byCause[0]!.count).toBe(2);
    expect(summary.byProduct[0]!.modelNumber).toBe("TX-100");
  });

  it("reports no rate over no claims", () => {
    expect(warrantySummary([]).aiesCausedPct).toBeNull();
  });
});

describe("§16's renewal loop, the half §11 needs", () => {
  it("finds warranties inside the window and ignores those already expired", () => {
    const equipment = [
      { id: "soon", warrantyEnd: "2026-09-15T00:00:00.000Z" },
      { id: "later", warrantyEnd: "2027-06-01T00:00:00.000Z" },
      { id: "gone", warrantyEnd: "2026-01-01T00:00:00.000Z" },
      { id: "nowindow", warrantyEnd: null },
    ];
    const expiring = expiringWithin(equipment, 90, on("2026-08-17T00:00:00.000Z"));
    expect(expiring.map((entry) => entry.id)).toEqual(["soon"]);
  });

  it("sorts the soonest first, because that is the order sales works them", () => {
    const equipment = [
      { id: "b", warrantyEnd: "2026-10-01T00:00:00.000Z" },
      { id: "a", warrantyEnd: "2026-09-01T00:00:00.000Z" },
    ];
    const expiring = expiringWithin(equipment, 90, on("2026-08-17T00:00:00.000Z"));
    expect(expiring.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

/**
 * Misuse is not a defect — the company's correction to §11, 2026-08-20.
 *
 * §11 as written said "in warranty → billable = false" and stopped there, which made a customer who
 * ran a pump dry inside the warranty year AIES's cost to bear. That is not what a warranty is: it
 * covers the equipment being defective, not the equipment being broken, and AIES cannot offer cover
 * the principal behind it does not.
 */
describe("misuse inside the warranty window", () => {
  it("charges the customer who caused it, even in warranty", () => {
    const verdict = determine({ coverage: "in_warranty", attribution: "customer_caused" });
    expect(verdict.billable).toBe(true);
    expect(verdict.referToSales).toBe(true);
    // No warranty ticket: this is quoted work, not rectification the company owes.
    expect(verdict.raisesTicket).toBe(false);
  });

  it("charges third-party damage the same way", () => {
    // A contractor putting a forklift through it is not the equipment failing.
    expect(determine({ coverage: "in_warranty", attribution: "third_party" }).billable).toBe(true);
  });

  it("does not charge when the manufacturer's terms cover it anyway", () => {
    const verdict = determine({
      coverage: "in_warranty",
      attribution: "customer_caused",
      manufacturerCovers: true,
    });
    expect(verdict.billable).toBe(false);
    expect(verdict.raisesTicket).toBe(true);
    // And says it is an exception rather than the ordinary answer, because the next person reading
    // this needs to know which it was.
    expect(verdict.reason).toMatch(/exception/);
  });

  it("still covers an ordinary defect in warranty", () => {
    // The rule change must not have made the common case chargeable.
    const verdict = determine({ coverage: "in_warranty", attribution: "undetermined" });
    expect(verdict.billable).toBe(false);
    expect(verdict.raisesTicket).toBe(true);
  });

  it("still refuses to charge for AIES's own defect, in or out of warranty", () => {
    // aies_caused is decided before coverage is even read, and must stay that way.
    for (const coverage of ["in_warranty", "out_of_warranty"] as const) {
      const verdict = determine({ coverage, attribution: "aies_caused" });
      expect(verdict.billable, coverage).toBe(false);
      expect(verdict.ncrRequired, coverage).toBe(true);
    }
  });
});
