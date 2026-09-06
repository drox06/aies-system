import { describe, expect, it } from "vitest";
import {
  BILLING_TRIGGERS,
  checkTermMilestones,
  dueDateFor,
  milestonesTriggeredBy,
  planMilestones,
  type TermMilestone,
} from "@/server/core/finance/billing-rules";

/**
 * specs/05-finance-billing.md §2, as pure functions.
 *
 * The cases that matter are the ones where a plausible simplification loses money: a term that does
 * not sum to the contract, a split that loses a centavo, a trigger that fires twice, and a due date
 * that quietly doubles a payment term.
 */

const term = (milestones: TermMilestone[]) => milestones;

describe("whether a term can be billed from", () => {
  it("accepts a 50/50", () => {
    const check = checkTermMilestones(
      term([
        { label: "Downpayment", pct: "50", trigger: "on_order" },
        { label: "Balance", pct: "50", trigger: "on_project_close" },
      ]),
    );
    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
  });

  /**
   * The most expensive possible configuration error, and the reason this is an error rather than a
   * warning: a term summing to 90% leaves a tenth of the contract with no milestone to bill it on,
   * and nobody notices until the project closes and the final statement is short.
   */
  it("refuses a term that does not add up to the contract", () => {
    const short = checkTermMilestones(
      term([
        { label: "Downpayment", pct: "30", trigger: "on_order" },
        { label: "Balance", pct: "60", trigger: "on_project_close" },
      ]),
    );
    expect(short.ok).toBe(false);
    expect(short.errors.join(" ")).toMatch(/have to come to 100%/);

    const over = checkTermMilestones(
      term([
        { label: "Downpayment", pct: "60", trigger: "on_order" },
        { label: "Balance", pct: "60", trigger: "on_project_close" },
      ]),
    );
    expect(over.ok).toBe(false);
  });

  it("refuses a milestone that bills nothing, and one with no trigger anybody fires", () => {
    expect(
      checkTermMilestones(
        term([
          { label: "Nothing", pct: "0", trigger: "on_order" },
          { label: "Everything", pct: "100", trigger: "on_project_close" },
        ]),
      ).ok,
    ).toBe(false);

    expect(
      checkTermMilestones(
        term([{ label: "All", pct: "100", trigger: "when_the_moon_is_right" as never }]),
      ).ok,
    ).toBe(false);
  });

  it("refuses a days-after-close milestone that does not say how many days", () => {
    const check = checkTermMilestones(
      term([{ label: "Retention", pct: "100", trigger: "net_days_after_close" }]),
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/does not say how many/);
  });

  it("allows two milestones on one trigger, and says it is worth checking", () => {
    const check = checkTermMilestones(
      term([
        { label: "First half", pct: "50", trigger: "on_project_close" },
        { label: "Second half", pct: "50", trigger: "on_project_close" },
      ]),
    );
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/share a trigger/);
  });
});

describe("splitting an order across milestones", () => {
  it("splits evenly when it divides", () => {
    const planned = planMilestones(1_000_000, [
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance", pct: "50", trigger: "on_project_close" },
    ]);
    expect(planned.map((m) => m.amount)).toEqual([500_000, 500_000]);
  });

  /**
   * The centavo. ₱10,000.01 split 50/50 is ₱5,000.005 twice, which does not exist — and a schedule
   * whose milestones do not sum to the contract is short at the end, which is the same failure as a
   * term summing to 90% arrived at through arithmetic instead of configuration.
   */
  it("gives the remainder to the last milestone rather than losing it", () => {
    const planned = planMilestones(1_000_001, [
      { label: "Downpayment", pct: "50", trigger: "on_order" },
      { label: "Balance", pct: "50", trigger: "on_project_close" },
    ]);
    expect(planned.map((m) => m.amount)).toEqual([500_001, 500_000]);
    expect(planned.reduce((sum, m) => sum + m.amount, 0)).toBe(1_000_001);
  });

  it("sums to the contract across three uneven milestones", () => {
    const total = 3_333_337;
    const planned = planMilestones(total, [
      { label: "Advance", pct: "20", trigger: "on_order" },
      { label: "Commissioning", pct: "50", trigger: "on_tc_accepted" },
      { label: "Final", pct: "30", trigger: "on_project_close" },
    ]);
    expect(planned.reduce((sum, m) => sum + m.amount, 0)).toBe(total);
  });

  it("keeps the percentage as agreed, alongside the amount it came to", () => {
    const planned = planMilestones(1_000_000, [
      { label: "Downpayment", pct: "33.3333", trigger: "on_order" },
      { label: "Balance", pct: "66.6667", trigger: "on_project_close" },
    ]);
    expect(planned[0]!.pct).toBe("33.3333");
    expect(planned[0]!.amount).toBe(333_333);
    expect(planned[1]!.amount).toBe(666_667);
  });

  it("handles a zero-value order without inventing money", () => {
    const planned = planMilestones(0, [{ label: "All", pct: "100", trigger: "on_project_close" }]);
    expect(planned[0]!.amount).toBe(0);
  });
});

describe("which milestones an event makes billable", () => {
  const milestone = (trigger: string, status = "pending") => ({ trigger, status });

  it("matches every trigger that listens to that event", () => {
    // Both of these listen to project.closed and differ only in when the money is due.
    const matched = milestonesTriggeredBy("project.closed", [
      milestone("on_project_close"),
      milestone("net_days_after_close"),
      milestone("on_order"),
    ]);
    expect(matched).toHaveLength(2);
  });

  /**
   * §11: "Milestone triggers fire exactly once per event". The transition is the record of having
   * fired, so anything already past `pending` is not returned — which is what makes a redelivered
   * event harmless.
   */
  it("ignores a milestone that has already had its turn", () => {
    const matched = milestonesTriggeredBy("project.closed", [
      milestone("on_project_close", "ready_to_bill"),
      milestone("on_project_close", "invoiced"),
      milestone("on_project_close", "cancelled"),
    ]);
    expect(matched).toEqual([]);
  });

  it("matches nothing for an event no term listens to", () => {
    expect(milestonesTriggeredBy("quotation.sent", [milestone("on_order")])).toEqual([]);
  });

  it("maps every trigger to an event some module actually emits, except the one that is manual on purpose", () => {
    // A trigger pointing at an event nothing fires is a milestone that can never become billable.
    // The list is asserted rather than derived so that adding a trigger is a deliberate act.
    // `manual`'s string is never published through the outbox — see its own comment in
    // billing-rules.ts — it exists only so `releaseMilestoneService` can share this file's matching.
    expect(Object.values(BILLING_TRIGGERS)).toEqual([
      "sales_order.created",
      "supplier_po.sent",
      "sales_order.goods_delivered",
      "qa.passed",
      "tc.completed",
      "delivery.dr_signed",
      "project.closed",
      "project.closed",
      "billing_milestone.released",
    ]);
  });
});

describe("when the money is due", () => {
  const readyAt = new Date("2026-03-10T00:00:00.000Z");

  it("adds the term's net days", () => {
    const due = dueDateFor(readyAt, 15, { trigger: "on_project_close", daysAfter: null });
    expect(due.toISOString().slice(0, 10)).toBe("2026-03-25");
  });

  /**
   * "30 days after close, net 30" must not quietly mean sixty. The delay replaces the term's net
   * days rather than stacking on top of them.
   */
  it("does not double a term that already runs from close", () => {
    const due = dueDateFor(readyAt, 30, { trigger: "net_days_after_close", daysAfter: 30 });
    expect(due.toISOString().slice(0, 10)).toBe("2026-04-09");
  });

  it("crosses a month and a year boundary correctly", () => {
    const due = dueDateFor(new Date("2026-12-20T00:00:00.000Z"), 30, {
      trigger: "on_project_close",
      daysAfter: null,
    });
    expect(due.toISOString().slice(0, 10)).toBe("2027-01-19");
  });
});
