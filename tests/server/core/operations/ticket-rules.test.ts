import { describe, expect, it } from "vitest";
import {
  linesNeedingNoTicket,
  proposeTickets,
  ticketNeedsProject,
  uncoveredLines,
  type ProposalLine,
} from "@/server/core/operations/ticket-rules";

/**
 * specs/04-operations-projects.md §4's proposal, as a pure function.
 *
 * §20's first named test: "Ticket generation from a mixed sales order proposes the correct type
 * set; operations edits are respected; each ticket links the right sales order lines." The first
 * and third clauses are here; the second is about the service, and lives in ticket.test.ts.
 */

const line = (overrides: Partial<ProposalLine> & { salesOrderLineId: string }): ProposalLine => ({
  lineNo: 1,
  description: "Flow meter DN150",
  requiresExecution: false,
  itemType: "product",
  ...overrides,
});

describe("§4's proposal from a mixed order", () => {
  it("proposes one installation ticket and one delivery ticket", () => {
    const proposed = proposeTickets({
      reference: "AIESSO-260001",
      lines: [
        line({ salesOrderLineId: "a", lineNo: 1, description: "Flow meter DN150" }),
        line({ salesOrderLineId: "b", lineNo: 2, description: "Gaskets" }),
        line({
          salesOrderLineId: "c",
          lineNo: 3,
          description: "Commissioning",
          requiresExecution: true,
          itemType: "service",
        }),
      ],
    });

    expect(proposed.map((ticket) => ticket.type)).toEqual(["installation", "delivery"]);
    // §4: "Each ticket links back to the specific sales order lines it covers."
    expect(proposed[0]!.salesOrderLineIds).toEqual(["c"]);
    expect(proposed[1]!.salesOrderLineIds).toEqual(["a", "b"]);
  });

  it("merges several execution lines into one ticket, not one each", () => {
    // Two meters installed at one site on one visit is one job. Splitting per line would put two
    // tickets on one van, and the reviewer would merge them — so the proposal starts merged.
    const proposed = proposeTickets({
      reference: "AIESSO-260002",
      lines: [
        line({ salesOrderLineId: "a", requiresExecution: true, itemType: "service" }),
        line({ salesOrderLineId: "b", lineNo: 2, requiresExecution: true, itemType: "labour" }),
      ],
    });

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.salesOrderLineIds).toEqual(["a", "b"]);
  });

  it("proposes only a delivery ticket for a goods-only order", () => {
    const proposed = proposeTickets({
      reference: "AIESSO-260003",
      lines: [line({ salesOrderLineId: "a" }), line({ salesOrderLineId: "b", lineNo: 2 })],
    });

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.type).toBe("delivery");
  });

  it("proposes nothing for an order with no lines left to cover", () => {
    expect(proposeTickets({ reference: "AIESSO-260004", lines: [] })).toEqual([]);
  });

  it("offers installation rather than guessing at new_project, and says so", () => {
    // Nothing on a sales order line distinguishes building something from fitting into what is
    // there. A guess would be a wrong answer that looks authoritative.
    const proposed = proposeTickets({
      reference: "AIESSO-260005",
      lines: [line({ salesOrderLineId: "a", requiresExecution: true, itemType: "service" })],
    });

    expect(proposed[0]!.type).toBe("installation");
    expect(proposed[0]!.rationale).toMatch(/new project/i);
    expect(proposed[0]!.rationale).toMatch(/starting point rather than a decision/);
  });

  it("names the order in every title, because 'Installation' tells a technician nothing", () => {
    const proposed = proposeTickets({
      reference: "AIESSO-260006",
      lines: [
        line({ salesOrderLineId: "a", requiresExecution: true, itemType: "service" }),
        line({ salesOrderLineId: "b", lineNo: 2 }),
      ],
    });

    for (const ticket of proposed) expect(ticket.title).toContain("AIESSO-260006");
  });
});

describe("which tickets get a project", () => {
  it("is the three execution types, and never delivery", () => {
    // §1: the delivery lane "is not a step inside a project — it is a ticket type".
    expect(ticketNeedsProject("new_project")).toBe(true);
    expect(ticketNeedsProject("installation")).toBe(true);
    expect(ticketNeedsProject("after_sales")).toBe(true);
    expect(ticketNeedsProject("delivery")).toBe(false);
  });
});

describe("lines nobody was asked to do", () => {
  it("reports what a confirmed set leaves uncovered", () => {
    const lines = [
      line({ salesOrderLineId: "a" }),
      line({ salesOrderLineId: "b", lineNo: 2 }),
      line({ salesOrderLineId: "c", lineNo: 3 }),
    ];

    const left = uncoveredLines(lines, [
      { salesOrderLineIds: ["a"] },
      { salesOrderLineIds: ["c"] },
    ]);
    expect(left.map((l) => l.salesOrderLineId)).toEqual(["b"]);
  });

  it("reports none when everything is covered", () => {
    const lines = [line({ salesOrderLineId: "a" })];
    expect(uncoveredLines(lines, [{ salesOrderLineIds: ["a"] }])).toEqual([]);
  });
});

/**
 * The company's report, 2026-08-19: "if goods receive is not an item but service, this should be
 * able to bypass booking a delivery since this does not require any inspection or there is nothing
 * to be physically delivered."
 *
 * The old rule was `!requiresExecution` means goods, so a travel line, a freight charge and a misc
 * fee each proposed a **delivery** ticket. The cost was not a spare ticket: §13 holds a delivery at
 * `delivered_unsigned` until a signature arrives and gates billing on it, so a freight line would
 * sit unsigned forever — keeping a finished order incomplete and blocking the invoice the freight
 * was charged on.
 */
describe("what actually needs delivering", () => {
  const line = (lineNo: number, itemType: string, requiresExecution: boolean) => ({
    salesOrderLineId: `line-${lineNo}`,
    lineNo,
    description: `${itemType} line`,
    requiresExecution,
    itemType,
  });

  it("proposes a delivery for products and nothing else", () => {
    const proposed = proposeTickets({
      lines: [
        line(1, "product", false),
        line(2, "freight", false),
        line(3, "travel", false),
        line(4, "misc", false),
      ],
      reference: "AIESSO-260001",
    });

    const delivery = proposed.filter((ticket) => ticket.type === "delivery");
    expect(delivery).toHaveLength(1);
    // Only the product line is on it.
    expect(delivery[0]!.salesOrderLineIds).toEqual(["line-1"]);
  });

  it("proposes no ticket at all for an order of nothing but charges", () => {
    const proposed = proposeTickets({
      lines: [line(1, "freight", false), line(2, "misc", false)],
      reference: "AIESSO-260002",
    });
    expect(proposed).toEqual([]);
  });

  it("names the lines that need nothing, so they are not mistaken for dropped work", () => {
    const lines = [
      line(1, "product", false),
      line(2, "service", true),
      line(3, "freight", false),
      line(4, "travel", false),
    ];
    expect(linesNeedingNoTicket(lines).map((l) => l.lineNo)).toEqual([3, 4]);
  });

  it("still sends service and labour to an execution ticket", () => {
    const proposed = proposeTickets({
      lines: [line(1, "service", true), line(2, "labour", true)],
      reference: "AIESSO-260003",
    });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.type).toBe("installation");
    expect(linesNeedingNoTicket([line(1, "service", true)])).toEqual([]);
  });
});
