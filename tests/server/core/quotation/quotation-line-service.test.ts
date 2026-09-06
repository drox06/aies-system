import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateNetDaysTermService } from "@/server/core/quotation/quotation-line-service";

/**
 * docs/DECISIONS.md #187 — term 7's own words, corrected: *"finance can trigger 'are we ready to
 * bill?' and operations can trigger 'we can bill this'"* is the same exchange #184/#185 built for
 * terms 4 through 6, not the automatic `net_days_after_close` this first shipped with. "Net N days"
 * is the payment window after release, not a delay before billing starts.
 */

const termIds: string[] = [];

afterAll(async () => {
  await db.paymentTerm.deleteMany({ where: { id: { in: termIds } } });
});

describe("the 'Net N days after completion' term", () => {
  it("creates a manual milestone, not an automatic one", async () => {
    const days = 100 + Math.floor(Math.random() * 100); // collision-proof across reruns
    const term = await getOrCreateNetDaysTermService(days);
    termIds.push(term.id);

    expect(term.netDays).toBe(days);
    expect(term.milestones).toEqual([{ label: "Full amount", pct: "100", trigger: "manual" }]);
  });

  it("is idempotent by day count, and reactivates a retired one", async () => {
    const days = 300 + Math.floor(Math.random() * 100);
    const first = await getOrCreateNetDaysTermService(days);
    termIds.push(first.id);

    await db.paymentTerm.update({ where: { id: first.id }, data: { isActive: false } });

    const second = await getOrCreateNetDaysTermService(days);
    expect(second.id).toBe(first.id);

    const row = await db.paymentTerm.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.isActive).toBe(true);
  });

  it("refuses a day count that is not a positive whole number", async () => {
    await expect(getOrCreateNetDaysTermService(0)).rejects.toThrow(/greater than zero/);
    await expect(getOrCreateNetDaysTermService(-5)).rejects.toThrow(/greater than zero/);
    await expect(getOrCreateNetDaysTermService(1.5)).rejects.toThrow(/whole number/);
  });
});
