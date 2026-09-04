import { describe, expect, it } from "vitest";
import {
  CASH_ADVANCE_CATEGORIES,
  breakdownTotal,
  canRequestAdvance,
  cashAdvanceGate,
  liquidationDueFrom,
  liquidationStanding,
  liquidationTotals,
  pendingExtension,
  reconcile,
  approvedExtensions,
} from "@/server/core/operations/cash-advance-rules";

/**
 * specs/04-operations-projects.md §5, as pure functions.
 *
 * §20's fourth case: "**Cash advance gate blocks mobilization; override is logged; liquidation
 * overdue blocks the next request.**" Three claims, and every one of them is a rule rather than a
 * database behaviour — so they are tested here, where a wrong answer is visible in one line rather
 * than at the end of a fixture.
 */

const APPROVED_EXTENSION = (newDueAt: string, reason: string) => ({
  requestedAt: "2026-08-01T00:00:00.000Z",
  requestedById: "u1",
  reason,
  newDueAt,
  approvedById: "vp",
  approvedAt: "2026-08-02T00:00:00.000Z",
});

describe("§5's categories", () => {
  it("is the eight the spec names, and nothing else", () => {
    expect([...CASH_ADVANCE_CATEGORIES]).toEqual([
      "transport",
      "fuel",
      "meals",
      "accommodation",
      "tolls_and_parking",
      "permits_and_gate_passes",
      "consumables",
      "contingency",
    ]);
  });
});

describe("§1's Gate 1", () => {
  it("does not block a ticket that needs no advance", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: false }, []);
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);
  });

  it("blocks when an advance is required and none has been raised", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, []);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/none has been requested/);
  });

  /**
   * The distinction the whole section is about.
   *
   * §5's complaint is the gap between a decision and cash in a pocket. An approved-but-unreleased
   * advance is precisely that gap, and a gate that cleared on approval would erase the one state
   * worth seeing.
   */
  it("still blocks when the advance is approved but not released", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [{ status: "approved" }]);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/not been handed over/);
  });

  it("blocks while the Vice President still has it", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [{ status: "pending_approval" }]);
    expect(gate.blocks).toBe(true);
  });

  /**
   * `endorsed` (docs/DECISIONS.md #175) fell through every branch here on first pass — it matched
   * neither `released`, `liquidated`, nor the old three-way `pending` find — and the gate reported
   * "none has been requested" for a ticket that plainly had one. Pinned so it cannot silently regress.
   */
  it("blocks on an endorsed advance, and says so rather than claiming none was requested", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [{ status: "endorsed" }]);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/endorsed/);
    expect(gate.message).not.toMatch(/none has been requested/);
  });

  it("clears once the money is released", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [{ status: "released" }]);
    expect(gate.state).toBe("satisfied");
    expect(gate.blocks).toBe(false);
  });

  it("clears on a liquidated advance — the money went out and came back accounted for", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [{ status: "liquidated" }]);
    expect(gate.blocks).toBe(false);
  });

  /** §5 allows a top-up: the question is whether *any* advance is out, not whether the newest is. */
  it("clears when any advance is released, even if a later one is still a draft", () => {
    const gate = cashAdvanceGate({ cashAdvanceRequired: true }, [
      { status: "released" },
      { status: "draft" },
    ]);
    expect(gate.blocks).toBe(false);
  });
});

describe("§5's three working days", () => {
  it("skips the weekend", () => {
    // Thursday 2026-08-13 → Fri, Mon, Tue = 2026-08-18.
    const due = liquidationDueFrom(new Date("2026-08-13T02:00:00.000Z"));
    expect(due.toISOString().slice(0, 10)).toBe("2026-08-18");
  });

  it("never lands on a Saturday or Sunday", () => {
    for (let day = 1; day <= 28; day += 1) {
      const from = new Date(Date.UTC(2026, 7, day, 2, 0, 0));
      const due = liquidationDueFrom(from);
      expect([0, 6]).not.toContain(due.getUTCDay());
    }
  });
});

describe("§5's register: outstanding, extended, late", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");

  it("reports nothing owed before release", () => {
    expect(liquidationStanding({ status: "approved", liquidationDueAt: null }, now).state).toBe(
      "not_released",
    );
  });

  it("reports settled once liquidated", () => {
    expect(
      liquidationStanding({ status: "liquidated", liquidationDueAt: new Date("2026-08-01") }, now)
        .state,
    ).toBe("settled");
  });

  it("is outstanding while inside the deadline", () => {
    const standing = liquidationStanding(
      { status: "released", liquidationDueAt: new Date("2026-08-25T00:00:00.000Z") },
      now,
    );
    expect(standing.state).toBe("outstanding");
  });

  it("is late once past it, and counts the days", () => {
    const standing = liquidationStanding(
      { status: "released", liquidationDueAt: new Date("2026-08-15T00:00:00.000Z") },
      now,
    );
    expect(standing.state).toBe("late");
    expect(standing.daysOverdue).toBe(5);
  });

  /**
   * The middle state, which §5 insists on: "formally extended **and why**".
   *
   * Collapsing it into "outstanding" loses the reason; collapsing it into "late" turns an approved
   * delay into an accusation.
   */
  it("is extended — with the reason — when an approved extension is in force", () => {
    const standing = liquidationStanding(
      {
        status: "extended",
        liquidationDueAt: new Date("2026-08-15T00:00:00.000Z"),
        extensions: [APPROVED_EXTENSION("2026-08-28T00:00:00.000Z", "Crew still on site in Cebu")],
      },
      now,
    );
    expect(standing.state).toBe("extended");
    expect(standing.extensionReason).toBe("Crew still on site in Cebu");
    expect(standing.dueAt?.toISOString().slice(0, 10)).toBe("2026-08-28");
  });

  it("goes late again once even the extended deadline passes", () => {
    const standing = liquidationStanding(
      {
        status: "extended",
        liquidationDueAt: new Date("2026-08-01T00:00:00.000Z"),
        extensions: [APPROVED_EXTENSION("2026-08-10T00:00:00.000Z", "Waiting on fuel receipts")],
      },
      now,
    );
    expect(standing.state).toBe("late");
    expect(standing.message).toMatch(/extended deadline/);
  });

  /**
   * The security property of the whole extension design.
   *
   * §5: "never a silent edit of the deadline". If an unapproved row moved the date, anybody could
   * extend their own deadline by filing a form, and the Vice President's approval would be theatre.
   */
  it("ignores an extension nobody has approved", () => {
    const advance = {
      status: "released",
      liquidationDueAt: new Date("2026-08-15T00:00:00.000Z"),
      extensions: [
        {
          requestedAt: "2026-08-14T00:00:00.000Z",
          requestedById: "u1",
          reason: "Please, receipts are with the driver",
          newDueAt: "2026-09-30T00:00:00.000Z",
          approvedById: null,
          approvedAt: null,
        },
      ],
    };
    expect(liquidationStanding(advance, now).state).toBe("late");
    expect(approvedExtensions(advance.extensions)).toHaveLength(0);
    expect(pendingExtension(advance.extensions)?.reason).toMatch(/driver/);
  });

  it("takes the newest approved extension when there are several", () => {
    const standing = liquidationStanding(
      {
        status: "extended",
        liquidationDueAt: new Date("2026-08-01T00:00:00.000Z"),
        extensions: [
          APPROVED_EXTENSION("2026-08-10T00:00:00.000Z", "first"),
          APPROVED_EXTENSION("2026-08-30T00:00:00.000Z", "second"),
        ],
      },
      now,
    );
    expect(standing.extensionReason).toBe("second");
  });

  it("says so, rather than implying on-time, when a released advance has no deadline", () => {
    const standing = liquidationStanding({ status: "released", liquidationDueAt: null }, now);
    expect(standing.state).toBe("outstanding");
    expect(standing.message).toMatch(/not tracked/);
  });
});

describe("§5's block on the next advance", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");

  it("allows a request when nothing is late", () => {
    expect(
      canRequestAdvance(
        [
          {
            number: "AIESCA-260001",
            status: "released",
            liquidationDueAt: new Date("2026-08-25T00:00:00.000Z"),
          },
        ],
        now,
      ).allowed,
    ).toBe(true);
  });

  it("blocks, and names the advance, when one is late", () => {
    const result = canRequestAdvance(
      [
        {
          number: "AIESCA-260001",
          status: "released",
          liquidationDueAt: new Date("2026-08-10T00:00:00.000Z"),
        },
      ],
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.blockingNumbers).toEqual(["AIESCA-260001"]);
    expect(result.message).toContain("AIESCA-260001");
  });

  /** An approved extension is the sanctioned way out of the block — otherwise granting one is empty. */
  it("does not block on a formally extended advance", () => {
    expect(
      canRequestAdvance(
        [
          {
            number: "AIESCA-260001",
            status: "extended",
            liquidationDueAt: new Date("2026-08-10T00:00:00.000Z"),
            extensions: [APPROVED_EXTENSION("2026-09-01T00:00:00.000Z", "Job ran long")],
          },
        ],
        now,
      ).allowed,
    ).toBe(true);
  });
});

describe("the money", () => {
  it("sums a breakdown in centavos", () => {
    expect(breakdownTotal([{ amount: 150_00 }, { amount: 32_50 }])).toBe(182_50);
  });

  it("counts the lines with no official receipt", () => {
    const totals = liquidationTotals([line(100_00, true), line(50_00, false), line(25_00, false)]);
    expect(totals.totalSpent).toBe(175_00);
    expect(totals.withoutOfficialReceipt).toBe(2);
  });

  /**
   * The bug this replaced.
   *
   * The first version computed the balance to return as `released − spent` and called the advance
   * settled on that basis — which treated money still in the technician's pocket as though it were
   * already back in the drawer, made every liquidation settle on the first receipt, and left §5's
   * `partially_liquidated` unreachable.
   */
  it("does not settle an advance just because receipts were filed", () => {
    const result = reconcile({ amountReleased: 500_00, totalSpent: 200_00, amountReturned: 0 });
    expect(result.settled).toBe(false);
    expect(result.unaccounted).toBe(300_00);
  });

  it("settles once receipts and returned cash together cover the release", () => {
    const result = reconcile({
      amountReleased: 500_00,
      totalSpent: 200_00,
      amountReturned: 300_00,
    });
    expect(result.settled).toBe(true);
    expect(result.unaccounted).toBe(0);
    expect(result.balanceReimbursable).toBe(0);
  });

  it("owes the technician when they spent more than they were given", () => {
    const result = reconcile({ amountReleased: 500_00, totalSpent: 620_00, amountReturned: 0 });
    expect(result.settled).toBe(true);
    expect(result.balanceReimbursable).toBe(120_00);
  });
});

function line(amount: number, hasOfficialReceipt: boolean) {
  return {
    date: "2026-08-20",
    category: "transport",
    description: "",
    amount,
    hasOfficialReceipt,
  };
}
