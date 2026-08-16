import { describe, expect, it } from "vitest";
import {
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
