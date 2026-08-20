import { describe, expect, it } from "vitest";
import { urgencyFor } from "@/server/core/finance/cash-advance-queue";

/**
 * §5b's release queue, and the one judgement in it.
 *
 * Most of `releaseQueueService` is a query — approved advances, soonest needed first — and a query
 * is better checked by looking at the screen than by asserting Prisma returns what Prisma returns.
 * What is worth pinning is the **urgency boundary**, because it encodes a decision that is easy to
 * get subtly wrong and impossible to notice: how early an advance starts shouting.
 */
describe("how loudly a waiting advance reads", () => {
  it("treats tomorrow as urgent, not as comfortable", () => {
    /*
      The case §5b names by hand: "a crew scheduled to mobilize tomorrow morning with an unreleased
      advance is the top of this list."

      One day out has to be urgent rather than merely soon, because the work of releasing happens in
      banking hours today. An advance needed at 07:00 tomorrow that reads as "soon" this afternoon is
      a crew standing at a gate in the morning.
    */
    expect(urgencyFor(1)).toBe("urgent");
    expect(urgencyFor(0)).toBe("urgent");
  });

  it("treats a passed date as late rather than as merely urgent", () => {
    // Late and urgent are different facts: one is a problem coming, the other is a promise already
    // broken, and finance triages them differently.
    expect(urgencyFor(-1)).toBe("late");
    expect(urgencyFor(-30)).toBe("late");
  });

  it("keeps the middle of the week distinct from next week", () => {
    // Three days is the working week's reach — a Monday advance needed Thursday is this week's
    // problem. Beyond that it is planning rather than queueing.
    expect(urgencyFor(2)).toBe("soon");
    expect(urgencyFor(3)).toBe("soon");
    expect(urgencyFor(4)).toBe("later");
  });

  it("has no gap or overlap between the bands", () => {
    // A boundary that skipped a value would leave a row with no urgency at all, and the screen would
    // render it in the fallback tone with nobody knowing why.
    const bands = new Set<string>();
    for (let days = -5; days <= 10; days += 1) bands.add(urgencyFor(days));
    expect(bands).toEqual(new Set(["late", "urgent", "soon", "later"]));
  });
});
