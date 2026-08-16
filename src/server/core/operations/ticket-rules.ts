/**
 * Ticket rules (specs/04-operations-projects.md §2, §3, §4).
 *
 * Pure — no Prisma — so the review screen shows exactly the proposal the server would generate from,
 * and so §4's routing can be tested without a database. On `UI_SAFE_SERVER_MODULES` in
 * eslint.config.mjs, same split as po-verification.ts and goods-receipt-rules.ts.
 */

export const TICKET_ENTITY_TYPE = "Ticket";
export const TICKET_DOCUMENT_TYPE = "ticket";
export const PROJECT_ENTITY_TYPE = "Project";
export const PROJECT_DOCUMENT_TYPE = "project";

/**
 * §2's four types, which are four *routes* rather than four labels.
 *
 * The company's own word is "ticket" and §2 says so twice: "use it in the UI, the code, and the
 * numbering. **Do not rename it to 'job order'.**"
 */
export const TICKET_TYPES = ["new_project", "installation", "after_sales", "delivery"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** §3's after-sales sub-types. Only meaningful when `type === "after_sales"`. */
export const AFTER_SALES_SUBTYPES = [
  "warranty",
  "corrective",
  "preventive",
  "calibration",
  "troubleshooting",
  "training",
] as const;

export const TICKET_PRIORITIES = ["low", "normal", "high", "emergency"] as const;

export const TICKET_STATUSES = [
  "generated",
  "cash_advance_pending",
  "material_pending",
  "ready_to_mobilize",
  "mobilized",
  "in_progress",
  "qa",
  "tc",
  "for_closeout",
  "completed",
  "cancelled",
  "on_hold",
] as const;

export const PROJECT_STATUSES = [
  "planning",
  "site_inspection",
  "methodology",
  "mobilising",
  "in_progress",
  "qa",
  "tc",
  "for_closeout",
  "closed",
  "on_hold",
  "cancelled",
] as const;

/**
 * §2: "A **Project** exists only for `new_project`, `installation`, and `after_sales` tickets that
 * involve field execution. … A **Delivery ticket** has no project."
 *
 * A rule rather than a convention — a delivery ticket with a project would put it inside the
 * execution lane, which §1 is explicit it is not: "It is not a step inside a project — it is a
 * ticket type."
 */
export function ticketNeedsProject(type: string): boolean {
  return type === "new_project" || type === "installation" || type === "after_sales";
}

// ---- §4's proposal ------------------------------------------------------------------------------

export interface ProposalLine {
  salesOrderLineId: string;
  lineNo: number;
  description: string;
  /** Module 03 set this when the sales order was raised, from the quotation's `itemType`. */
  requiresExecution: boolean;
  itemType: string;
}

export interface ProposedTicket {
  type: TicketType;
  title: string;
  scopeOfWork: string;
  salesOrderLineIds: string[];
  /** Why the proposal picked this type, shown on the review screen beside it. */
  rationale: string;
}

/**
 * Reads a sales order's lines and **proposes** a set of tickets (§4).
 *
 * ## The rule this function exists to obey
 *
 * §4, in full, because it is the whole design of this session:
 *
 * > The system **proposes** tickets by reading the sales order lines: lines with `requiresExecution`
 * > propose an installation or new-project ticket; goods-only lines propose a delivery ticket…
 * > Operations **confirms or edits** the proposed set before generation. **Do not auto-generate
 * > silently — one PO can legitimately be one ticket or eight, and only a human knows which.**
 *
 * So this returns a *proposal*. Nothing here writes, nothing downstream generates from it without a
 * person pressing something, and `sales_order.created` produces something to review rather than
 * tickets. The temptation is obvious — the routing is mechanical and the events are already flowing
 * — and §4 rules it out in a sentence for a reason: a wrong ticket set is not a wrong record, it is
 * a crew at the wrong site on the wrong day.
 *
 * ## Why execution lines become one ticket and not several
 *
 * Two meters installed at one site on one visit is one job. Splitting per line would put two tickets
 * on one van, and the person reviewing would merge them — so the proposal starts merged and the
 * reviewer splits, which is the direction that makes the common case free.
 *
 * `new_project` versus `installation` is **not** decided here. §2 distinguishes them by whether
 * there is a project to build versus equipment to fit into an existing one, and nothing on a sales
 * order line says which. The proposal offers `installation` and says so; the reviewer changes it.
 * Guessing would produce a wrong answer that looks authoritative, which is worse than an honest one.
 */
export function proposeTickets(input: {
  lines: readonly ProposalLine[];
  /** For the titles — a ticket called "Installation" tells a technician nothing. */
  reference: string;
}): ProposedTicket[] {
  const execution = input.lines.filter((line) => line.requiresExecution);
  const goods = input.lines.filter((line) => !line.requiresExecution);

  const proposed: ProposedTicket[] = [];

  if (execution.length > 0) {
    proposed.push({
      type: "installation",
      title: `Installation — ${input.reference}`,
      scopeOfWork: execution.map((line) => `${line.lineNo}. ${line.description}`).join("\n"),
      salesOrderLineIds: execution.map((line) => line.salesOrderLineId),
      rationale:
        `${execution.length} line(s) need somebody on site. Change this to a new project if the ` +
        `work builds something rather than fitting into what is there — nothing on a sales order ` +
        `line says which, so this is a starting point rather than a decision.`,
    });
  }

  if (goods.length > 0) {
    proposed.push({
      type: "delivery",
      title: `Delivery — ${input.reference}`,
      scopeOfWork: goods.map((line) => `${line.lineNo}. ${line.description}`).join("\n"),
      salesOrderLineIds: goods.map((line) => line.salesOrderLineId),
      rationale:
        `${goods.length} goods-only line(s). A delivery ticket runs its own lane and never has a ` +
        `project.`,
    });
  }

  return proposed;
}

/**
 * Whether every line of an order is covered by the confirmed set, and which are not.
 *
 * §4: "Each ticket links back to the specific sales order lines it covers, so fulfilment counters
 * and billing milestones stay accurate." A line covered by no ticket is work nobody has been asked
 * to do — usually an edit that dropped it. Reported rather than refused: leaving a line out is
 * sometimes right, and only the reviewer knows.
 */
export function uncoveredLines(
  lines: readonly ProposalLine[],
  confirmed: readonly { salesOrderLineIds: readonly string[] }[],
): ProposalLine[] {
  const covered = new Set(confirmed.flatMap((ticket) => ticket.salesOrderLineIds));
  return lines.filter((line) => !covered.has(line.salesOrderLineId));
}
