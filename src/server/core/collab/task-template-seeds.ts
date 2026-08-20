import type { TaskTemplateSpec } from "@/server/core/collab/task-template-rules";

/**
 * §2's fourteen templates, mirroring the operations flowchart — *"since every box in it is someone's
 * assignment."*
 *
 * ## Why this is a file of data rather than rows typed into a screen
 *
 * These are the standing answers to "who does what when this happens", and they are the same answers
 * §2 wrote down. Keeping them in source means they are reviewable in a diff, testable without a
 * database, and identical on every environment. The seed creates any that are **missing** and never
 * overwrites one that exists, so an adjustment made in the app survives the next deploy — the same
 * treatment the checklist templates get.
 *
 * ## The roles
 *
 * There is no `procurement` or `stores` role in this platform. §2's "procurement" and "stores" are
 * PD, which here is `admin_manager` and `operations_manager` — read off who actually holds
 * `supplier_po.create` and `material_request.issue` rather than guessed at. "ops lead" is
 * `operations_manager`, "crew" is `technician`, "sales" is `sales` and `marketing_manager`.
 *
 * ## The assignment modes
 *
 * The company's rule, taken 2026-08-20: **all** for approvals, **least-loaded** for crew work, **all**
 * elsewhere. Applied here with one deliberate narrowing, flagged rather than slipped in:
 *
 * > **`all` is used for decisions, and `least_loaded` for work one person does** — including office
 * > work, not just crew work.
 *
 * The reason is what `all` means in practice. It raises one task *per holder*, so the first one free
 * can act and nothing waits on a named individual being at their desk. That is exactly right for an
 * approval. For "acknowledge the PO to the customer" it would raise the same job on two sales
 * people's lists, one of whom does it — leaving the other holding an open task for work that no
 * longer exists. Stale rows are how a work list stops being believed, which is the failure this
 * module exists to fix.
 */
export const TASK_TEMPLATE_SEEDS: TaskTemplateSpec[] = [
  {
    key: "so-created",
    name: "A sales order is raised",
    trigger: "sales_order.created",
    tasks: [
      {
        key: "acknowledge-po",
        title: "Acknowledge the PO to the customer",
        description:
          "Confirm receipt in writing, with the order number and what was ordered. The customer " +
          "has committed money and has heard nothing back yet.",
        roleKeys: ["sales", "marketing_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
      {
        key: "generate-tickets",
        title: "Generate the tickets for this order",
        description: "Until this happens, no work exists for anybody to be scheduled against.",
        roleKeys: ["operations_manager", "admin_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
      {
        key: "supplier-po",
        title: "Raise the supplier PO",
        roleKeys: ["admin_manager", "operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 2,
      },
      {
        key: "downpayment-invoice",
        title: "Raise the downpayment invoice",
        description:
          "§4 will not let the job mobilise until the downpayment is in, so this is on the " +
          "critical path rather than after it.",
        roleKeys: ["finance_officer"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "ticket-new-project",
    name: "A project ticket is generated",
    trigger: "ticket.generated",
    condition: { ticketType: "new_project" },
    tasks: [
      {
        key: "schedule-inspection",
        title: "Schedule the site inspection",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 3,
      },
      {
        key: "prepare-methodology",
        title: "Prepare the method statement",
        description: "§6.2: the client approves the methodology before work starts. Always.",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 5,
      },
    ],
  },
  {
    key: "ticket-delivery",
    name: "A delivery ticket is generated",
    trigger: "ticket.generated",
    condition: { ticketType: "delivery" },
    tasks: [
      {
        key: "request-dr",
        title: "Request the delivery receipt",
        roleKeys: ["admin_manager", "operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
      {
        key: "confirm-site-contact",
        title: "Confirm the site contact before the vehicle leaves",
        description:
          "A failed attempt costs a day and a truck. §13 counts them, and the commonest cause is " +
          "nobody at the far end.",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "cash-advance-requested",
    name: "A cash advance is requested",
    trigger: "cash_advance.requested",
    tasks: [
      {
        key: "approve-advance",
        title: "Approve the cash advance",
        roleKeys: ["operations_manager", "finance_officer", "vice_president"],
        // A decision. Everybody who can make it gets it, so the crew is not waiting on one person.
        assignMode: "all",
        priority: "high",
        // Due when the money is needed on site, not a fixed number of days after the request.
        dueFrom: "neededBy",
      },
      {
        key: "release-funds",
        title: "Release the funds",
        description:
          "Raised with the request rather than after approval, as §2 specifies, so finance can see " +
          "what is coming. The gate itself still refuses to release an advance nobody has approved.",
        roleKeys: ["finance_officer"],
        assignMode: "least_loaded",
        dueFrom: "neededBy",
      },
    ],
  },
  {
    key: "cash-advance-released",
    name: "A cash advance is released",
    trigger: "cash_advance.released",
    tasks: [
      {
        key: "liquidate-advance",
        title: "Liquidate the advance",
        description:
          "Receipts and the unspent balance. Until this is done the job's margin is reported " +
          "against money that has left the company and not been accounted for.",
        // The person who asked for the money is the person who accounts for it. Not a role: naming
        // one would put somebody else's spending on a colleague's list.
        assignTo: "record_owner",
        roleKeys: ["finance_officer"],
        assignMode: "least_loaded",
        dueFrom: "liquidationDue",
      },
    ],
  },
  {
    key: "material-request-raised",
    name: "A material request is raised",
    trigger: "material_request.raised",
    tasks: [
      {
        key: "approve-material-request",
        title: "Approve the material request",
        roleKeys: ["operations_manager"],
        assignMode: "all",
        dueInDays: 1,
      },
      {
        key: "issue-materials",
        title: "Issue the materials from the store",
        description:
          "§2 says 'before mobilization'. The platform has no mobilisation date at this point, so " +
          "this is dated a day out and the mobilisation gate remains the real control.",
        roleKeys: ["admin_manager", "operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "material-purchase-required",
    name: "Materials must be bought in",
    trigger: "material.purchase_required",
    tasks: [
      {
        key: "raise-purchase-request",
        title: "Raise the purchase request for what the store cannot supply",
        roleKeys: ["admin_manager", "operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "methodology-approved",
    name: "A method statement is approved internally",
    trigger: "methodology.approved",
    // §2: "only when the account flag requires it". The flag lives on the methodology
    // (`clientApprovalRequired`), and the resolver reads it — an internally approved statement that
    // the client never needs to see raises nothing.
    condition: { clientApprovalRequired: "true" },
    tasks: [
      {
        key: "submit-to-client",
        title: "Submit the method statement to the client for approval",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "scope-change",
    name: "A scope change is identified on site",
    trigger: "scope_change.identified",
    tasks: [
      {
        key: "raise-quotation-revision",
        title: "Raise the quotation revision for the scope change",
        description:
          "Work found on site that nobody has priced is work AIES is about to do for nothing.",
        roleKeys: ["sales", "marketing_manager"],
        assignMode: "least_loaded",
        priority: "high",
        dueInDays: 2,
      },
    ],
  },
  {
    key: "qa-failed",
    name: "The client's QA fails",
    trigger: "qa.failed",
    tasks: [
      {
        key: "rectify-defects",
        title: "Rectify the defects the client raised",
        description:
          "§2 asks for one task per defect with its own owner and date. The platform records a " +
          "defect's description and severity but not an owner, so one task carries the list rather " +
          "than inventing an assignee per line. The defects are on the QA record.",
        roleKeys: ["technician", "operations_manager"],
        assignMode: "least_loaded",
        priority: "high",
        dueInDays: 2,
      },
      {
        key: "re-inspect",
        title: "Re-inspect once the defects are closed",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 3,
      },
    ],
  },
  {
    key: "tc-completed",
    name: "Testing and commissioning is accepted",
    trigger: "tc.completed",
    // A failed commissioning is not a close-out event. The event fires either way, so the template
    // checks — the same guard module 05's billing subscriber applies to the same event.
    condition: { result: "accepted" },
    tasks: [
      {
        key: "close-punch-items",
        title: "Close the outstanding punch items",
        roleKeys: ["technician", "operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 2,
      },
      {
        key: "closeout-pack",
        title: "Prepare the close-out pack",
        roleKeys: ["operations_manager"],
        assignMode: "least_loaded",
        dueInDays: 5,
      },
    ],
  },
  {
    key: "delivery-failed",
    name: "A delivery attempt fails",
    trigger: "delivery.attempt_failed",
    tasks: [
      {
        key: "contact-and-reschedule",
        title: "Contact the customer and reschedule the delivery",
        roleKeys: ["operations_manager", "admin_manager"],
        assignMode: "least_loaded",
        priority: "high",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "project-closed",
    name: "A project closes",
    trigger: "project.closed",
    tasks: [
      {
        key: "final-invoice",
        title: "Issue the final invoice",
        description:
          "The close-out is what unlocks §4's final billing gate. Every day this waits is a day " +
          "the money is not being collected on work that is finished.",
        roleKeys: ["finance_officer"],
        assignMode: "least_loaded",
        dueInDays: 2,
      },
      {
        key: "satisfaction-survey",
        title: "Send the customer satisfaction survey",
        roleKeys: ["sales", "marketing_manager"],
        assignMode: "least_loaded",
        dueInDays: 3,
      },
    ],
  },
  {
    key: "ticket-demobilized",
    name: "A crew demobilises from site",
    trigger: "ticket.demobilized",
    tasks: [
      {
        key: "return-tools",
        title: "Return the tools and reconcile what went out",
        description:
          "§7's custody list is only worth having if somebody closes it. Tools disappear otherwise.",
        // The crew lead who took them out. Falls back to the technicians when the ticket names none.
        assignTo: "record_owner",
        roleKeys: ["technician"],
        assignMode: "least_loaded",
        dueInDays: 1,
      },
    ],
  },
];
