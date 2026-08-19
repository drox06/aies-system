import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 04 — Operations and Projects (specs/04-operations-projects.md).
 *
 * The largest module in the build: four gates, a delivery lane, an offline-first field application,
 * digital checklists and dispatch scheduling. Three sessions are in: §4's ticket and proposal, §5's
 * cash advance gate, §6.1's site inspection, §6.2's methodology, §7's material request and
 * §8's mobilisation and execution, and §9's client QA gate.
 *
 * §19 lists thirty permissions for the finished module; eighteen are here, because nine gate something.
 * **A permission is declared in the change that uses it** — the same rule `emits` follows, enforced
 * by tests/server/core/modules/permissions-are-used.test.ts. A permission declared ahead of its gate
 * sits in the admin role screen granting access to nothing; somebody assigns it and wonders why
 * nothing happened. docs/DECISIONS.md #52.
 *
 * `cash_advance.approve` and `cash_advance.approve_extension` are **not** here — they are foundation
 * permissions seeded by module 00, which needed them to seed the approval rules with §5's
 * four-working-hour escalation window. Redeclaring either would be a second owner for one key.
 */
export const operationsManifest = defineManifest({
  key: "operations",
  name: "Operations",
  version: "0.1.0",
  models: [
    "Ticket",
    "TicketSalesOrderLine",
    "Project",
    "CashAdvance",
    "CashAdvanceLiquidation",
    "SiteInspection",
    "Methodology",
    "MaterialRequest",
    "MaterialRequestLine",
    "StockItem",
    "StockMovement",
    "Mobilization",
    "DailyProgress",
    "QAApproval",
    "TestingCommissioning",
    "Equipment",
    "WarrantyClaim",
    "ServiceReport",
    "ProjectCloseOut",
    "DeliveryTicketFlow",
  ],

  permissions: [
    {
      key: "ticket.view",
      label: "View tickets",
      group: "Operations",
      // Wide: sales is asked when a job is happening, finance bills against it, procurement
      // supplies it. §19 scopes technicians to their own assignments — that is record scoping on
      // top of this, not a narrower grant.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "marketing_manager",
        "sales",
        "finance_officer",
        "technician",
      ],
    },
    {
      key: "ticket.view_all",
      label: "View every ticket, not just their own",
      group: "Operations",
      // §19: "Technicians are scoped to tickets where they are assigned." Kept off the technician
      // grant so that scoping means something.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "finance_officer",
      ],
    },
    {
      key: "ticket.generate",
      label: "Generate tickets from a sales order",
      group: "Operations",
      // §4: "Operations confirms or edits the proposed set before generation." DJ's job, and the
      // two officers as always.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "project.view_cost",
      label: "View a project's contract value, budget and actual cost",
      group: "Operations",
      // §19 is explicit that technicians "see scope, site data, and their own cash advances —
      // **never contract value or margin**". This is the permission that enforces that sentence.
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "cash_advance.request",
      label: "Request a cash advance",
      group: "Operations",
      // §5: "The request comes from the assigned team leader or the Operations Manager." Technicians
      // hold it because a team leader is a technician — §19 scopes what they can *see* to their own
      // advances, which is record scoping on top of this rather than a narrower grant.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "cash_advance.release",
      label: "Hand over the money for an approved cash advance",
      group: "Finance",
      // Deliberately **not** the same people who approve. §5 makes release a separate act from
      // approval because the gap between the two is the thing nobody could see; giving one person
      // both would close the gap by hiding it. This is the finance officer's, and PD's, since she
      // runs petty cash.
      defaultRoles: ["president", "finance_officer", "admin_manager"],
    },
    {
      key: "cash_advance.review_liquidation",
      label: "Check the physical receipts and settle a liquidation",
      group: "Finance",
      // §19 names this permission. §5 gives the liquidation a review cycle and it is finance's: the
      // app can record that receipts were filed, but only somebody holding the paper can say a BIR
      // official receipt exists.
      //
      /**
       * **Finance checks them; the president is the fallback.** Set by the company across two
       * conversations, and the pair of decisions is the interesting part.
       *
       * 2026-08-18: narrowed from four roles to finance alone. The reminder tells a technician to
       * hand the paper to finance, so finance is who checks it — a control four roles can perform is
       * not really a control, and a screen saying one thing while permissions allow another teaches
       * people that the words do not matter.
       *
       * 2026-08-19: the president added back, deliberately, as **cover** rather than as a second
       * approver. A five-person company has one finance officer, and one finance officer takes
       * holidays. Without a fallback the liquidation queue stops for a fortnight, advances age past
       * their deadline, and §5b's block on new requests starts biting crews who did nothing wrong.
       *
       * The vice-president is **not** on this list, which is the company's specific instruction and
       * a sound one: the VP approves the advance in the first place, and the person who authorised
       * the money should not also be the one who accepts the receipts for it.
       */
      defaultRoles: ["finance_officer", "president"],
    },
    {
      key: "cash_advance.view_register",
      label: "See every cash advance and what is outstanding",
      group: "Finance",
      // The register is who is holding company money right now. Management and finance; a
      // technician sees their own without this.
      defaultRoles: [
        "president",
        "vice_president",
        "finance_officer",
        "admin_manager",
        "operations_manager",
      ],
    },
    {
      key: "ticket.execute",
      label: "Record field work — site inspections and findings",
      group: "Operations",
      // §19: technicians do the work, so they hold this. The officers and DJ hold it because in a
      // five-person company they go to site too (Spec.md §1.2).
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "project.manage",
      label: "Plan a project and sign off its site inspection",
      group: "Operations",
      // §6.1's `approved` state. See INSPECTION_APPROVE_PERMISSION in site-inspection-rules.ts for
      // why an existing §19 key is reused rather than a new `inspection.approve` invented.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "methodology.prepare",
      label: "Write and revise method statements",
      group: "Operations",
      // §19. The people who plan the work; technicians included, because the team leader who will
      // run the job is usually the one who knows how it is actually done.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "methodology.approve",
      label: "Approve a method statement internally, before the client sees it",
      group: "Operations",
      // §6.2's internal sign-off. Deliberately not the technician who wrote it — the whole value of
      // a review is that somebody else read it.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "material_request.raise",
      label: "Raise a material request",
      group: "Operations",
      // §19. The team leader who knows what the job needs, and the people who plan it.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "material_request.approve",
      label: "Approve a material request",
      group: "Operations",
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "material_request.issue",
      label: "Issue materials from the store and record their return",
      group: "Operations",
      // The store is PD's. Deliberately not the technician drawing the tools — §7's custody list is
      // only worth having if somebody other than the borrower records the handover.
      defaultRoles: ["president", "admin_manager", "operations_manager"],
    },
    {
      key: "qa.record",
      label: "Record the client's QA outcome and upload their evidence",
      group: "Operations",
      // §19 names the level: "operations manager and above". Deliberately not the technician who did
      // the work — §9's whole point is that the verdict is the client's, and the person recording it
      // should not be the person it judges.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "delivery.execute",
      label: "Run a delivery: request the receipt, log attempts, capture the signature",
      group: "Operations",
      // §19. The driver records what happened at the door, so this sits with the crew rather than
      // with the officers — but the *document* is issued by procurement, and §7's gate means neither
      // can act without the other.
      defaultRoles: ["president", "vice_president", "operations_manager", "technician"],
    },
    {
      key: "checklist.fill",
      label: "Fill in and sign off a checklist",
      group: "Operations",
      // §15 replaces the verbal way work is confirmed, so the people doing the work hold this —
      // a checklist only an officer can sign is a countersignature, not a record of what happened.
      defaultRoles: ["president", "vice_president", "operations_manager", "technician"],
    },
    {
      key: "checklist.manage",
      label: "Write and publish checklist templates",
      group: "Admin",
      // Deliberately narrower than filling one in. A published version is immutable and becomes the
      // procedure of record, so authoring it is a quality-system act rather than a field one.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "timesheet.approve",
      label: "Approve hours and field expenses",
      group: "Operations",
      // Never your own — the service refuses it regardless of this permission. §16's claims on the
      // company follow §5's rule about cash advances rather than inventing a second answer.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "contract.manage",
      label: "Write and run maintenance contracts",
      group: "Sales",
      // §16 calls the renewal loop "where the recurring revenue in this business lives", so this
      // sits with the people who sell as well as the ones who deliver.
      defaultRoles: ["president", "vice_president", "operations_manager", "marketing_manager"],
    },
    {
      key: "project.view",
      label: "See projects and their close-out state",
      group: "Operations",
      // Held back since session 1 because nothing gated it. §12's checklist needs a screen — "so the
      // PM can see who owns each one" — so it comes back now, which is the rule working as intended.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "technician",
      ],
    },
    {
      key: "service_report.approve",
      label: "Approve a service report",
      group: "Operations",
      // §19. Separate from writing it: the customer signs what the technician wrote, and somebody
      // at AIES then stands behind it. One click doing both would collapse two different claims.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "project.close",
      label: "Close a project, releasing final billing",
      group: "Operations",
      // §12: closing "emits `project.closed` → module 05 releases final billing. This is the
      // explicit handover the brief describes." It asks a customer for money, so it sits high.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "warranty.determine",
      label: "Decide whether a warranty claim is covered, and who caused it",
      group: "Operations",
      // §11's determination is who-pays. Not the technician who did the original work — the same
      // reason §9 keeps the QA record away from the person it judges.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "equipment.manage",
      label: "Maintain the installed base",
      group: "Operations",
      // §19 names it. The warranty window lives here, and it decides who pays.
      defaultRoles: ["president", "vice_president", "operations_manager", "admin_manager"],
    },
    {
      key: "tc.signoff",
      label: "Sign off testing and commissioning",
      group: "Operations",
      // §19 names it on its own rather than folding it into `ticket.execute`, and §10 explains why:
      // the certificate this produces is "a primary billing trigger document". Signing it is a
      // commercial act, not a step in doing the work.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "ticket.dispatch",
      label: "Send a crew to site, and record their return",
      group: "Operations",
      // §19. Dispatching is DJ's, and the officers'. Deliberately not the technician being sent —
      // §8's readiness check is only worth having if somebody other than the crew signs it off.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "operations.override_methodology_gate",
      label: "Mobilize before the client has approved the method statement",
      group: "Operations",
      // §6.2: "president and VP only", and logged with a reason.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "operations.override_ca_gate",
      label: "Mobilize a crew before the cash advance is released",
      group: "Operations",
      // §5 allows the override "with a log". The two officers only — this is a decision to send
      // people to site on their own money, and it should sit with somebody who can answer for it.
      defaultRoles: ["president", "vice_president"],
    },
  ],

  /**
   * §18 lists twenty-eight events. Fifteen are emitted today.
   *
   * The registry rejects a subscription to an event nothing emits, so declaring the rest now would
   * let a later module subscribe to something that never fires — which fails silently, and is worse
   * than a boot error. Each is declared in the change that emits it.
   */
  emits: [
    "ticket.generated",
    "cash_advance.requested",
    "cash_advance.released",
    "cash_advance.liquidation_overdue",
    "site_inspection.completed",
    "scope_change.identified",
    "methodology.approved",
    "material_request.raised",
    "material.purchase_required",
    "material.issued",
    "ticket.mobilized",
    "ticket.started",
    "ticket.demobilized",
    "qa.passed",
    "qa.failed",
    "tc.completed",
    "punch_item.raised",
    "warranty.claim_raised",
    "warranty.expiring",
    "service_report.approved",
    "project.closed",
    "delivery.attempt_failed",
    "delivery.dr_signed",
    "delivery.dr_unsigned_overdue",
    "checklist.completed",
    // §15: a fail "can auto-raise an NCR". Module 04 decides which failures are worth one and
    // emits; specs/08-qms-iso9001.md §2 owns the register that raises them.
    "checklist.failed",
    "field_expense.approved",
    // §16's renewal loop. Emitted for module 01 to turn into leads — this module knows when one
    // is due, module 01 owns what a lead is.
    "renewal.due",
    "pm.due",
    "ticket.bumped",
    "sales_order.goods_delivered",
  ],

  /**
   * One subscription, and a deliberate absence.
   *
   * **Still absent: `sales_order.created`.** The obvious wiring is to subscribe to it and generate
   * tickets, and §4 forbids exactly that: "**Do not auto-generate silently — one PO can legitimately
   * be one ticket or eight, and only a human knows which.**" The proposal is computed on demand when
   * somebody opens the sales order, and a subscriber here would be a quiet way of doing the thing
   * the spec rules out. `operations-manifest.test.ts` pins its absence by name.
   *
   * `goods.received` and `payment.received` arrive when the gates that read them do.
   */
  consumes: [
    {
      /**
       * specs/01-crm-inquiry.md §5: "Module 04 subscribes and creates a scheduled field task."
       *
       * crm.prisma has carried that promise in a comment since module 01 was built — "when module 04
       * lands it consumes `inspection.requested` and this becomes the request of record with the
       * field task alongside it". This is module 04 landing.
       *
       * Unlike `sales_order.created`, there is no judgement being skipped here: somebody has already
       * decided a site needs visiting and said so on a form. Scheduling the visit they asked for is
       * mechanical, and §5 asks for it in as many words.
       */
      event: "inspection.requested",
      // Dynamically imported so registering the manifest does not pull Prisma into every consumer
      // of manifests.ts — which includes prisma/seed.ts and the nav tests.
      handler: async (payload) => {
        const { scheduleFromInspectionRequest } =
          await import("@/server/core/operations/site-inspection-service");
        await scheduleFromInspectionRequest(
          payload as {
            inspectionRequestId?: string;
            inquiryId?: string;
            siteId?: string | null;
            assignedToId?: string | null;
            dueAt?: string | null;
          },
        );
      },
    },
  ],

  nav: [
    {
      label: "Tickets",
      href: "/tickets",
      icon: "wrench",
      permission: "ticket.view",
      // After procurement (29) and suppliers (30): a ticket is what a delivered order becomes work.
      group: "Operations",
      order: 41,
    },
    {
      label: "Delivery mode",
      href: "/field",
      icon: "truck",
      /**
       * §14's driver screen needs a door.
       *
       * It was built shell-free and deliberately kept out of the navigation, which left it reachable
       * only by typing the URL — so the first person to look for it on a phone could not find it.
       * Stripped-down is about what the *screen* shows, not about being unreachable.
       *
       * Gated on `delivery.execute`, the same permission the screen's own queries use, so nobody is
       * offered a menu item that opens onto a 403.
       */
      permission: "delivery.execute",
      group: "Operations",
      order: 42,
    },
    {
      label: "Dispatch board",
      href: "/dispatch",
      icon: "folder-kanban",
      /**
       * §17's board. Readable by anybody who can see a ticket — a technician checking their own week
       * is the commonest use — while moving work needs `ticket.dispatch`.
       */
      permission: "ticket.view",
      group: "Operations",
      order: 40,
    },
    {
      label: "Checklists",
      href: "/checklists",
      icon: "clipboard-check",
      /**
       * The **library**, not the filling-in. Set by the company 2026-08-19: president, vice-president
       * and operations manager only.
       *
       * A technician fills a checklist in from the ticket they are working on, which is where the
       * work is. This entry is for the person who wants to see what templates exist and how they are
       * worded — a supervisory question. `checklist.manage` is exactly that permission, so gating on
       * it puts the entry in front of the three roles who hold it and nobody else.
       *
       * The panel on a ticket is unaffected: `checklist.fill` still governs that, and a technician
       * keeps it.
       *
       * §15's library needed a door: until 2026-08-18 the only route to a template was the panel on
       * a ticket, so the eleven seeded ones vanished whenever there were no tickets. It had one, and
       * it was `ticket.view` — everybody held to a procedure should be able to read it. The company
       * narrowed it on 2026-08-19; a technician still reaches every checklist that matters to them
       * from the job they are doing.
       */
      permission: "checklist.manage",
      group: "Operations",
      order: 43,
    },
    {
      label: "Renewals",
      href: "/renewals",
      icon: "badge-check",
      /**
       * §16: "this is where the recurring revenue in this business lives".
       *
       * Gated on `ticket.view` rather than `contract.manage` — the point of the loop is that sales
       * acts on it, and a screen only the people who write contracts can open would mean the leads
       * are raised for an audience of three.
       */
      permission: "ticket.view",
      group: "Sales",
      order: 12,
    },
    {
      label: "Maintenance contracts",
      href: "/contracts",
      icon: "clipboard-list",
      permission: "ticket.view",
      group: "Sales",
      order: 13,
    },
    {
      label: "Cash advances",
      href: "/cash-advances",
      icon: "wallet",
      // §5's register. Gated on the register permission rather than `cash_advance.request`, so a
      // technician is not given a menu item that shows them one row — their own advances are on
      // their ticket, where they are looking anyway.
      permission: "cash_advance.view_register",
      // Moved to Finance on 2026-08-19. Raised on a ticket, reviewed by finance — and this entry is
      // the register, not the request. See the note on module 05's nav.
      group: "Finance",
      order: 4,
    },
    {
      label: "Site inspections",
      href: "/inspections",
      icon: "clipboard-check",
      permission: "ticket.execute",
      group: "Operations",
      order: 42,
    },
    {
      label: "Store",
      href: "/store",
      icon: "package",
      // §7's minimum viable inventory, and the outstanding-custody list that is the reason it
      // exists — "tools disappear otherwise; this is universal".
      permission: "material_request.issue",
      group: "Operations",
      order: 45,
    },
    {
      label: "Method statements",
      href: "/methodologies",
      icon: "file-text",
      // §6.2's "with the client" view is the one that earns the nav entry — it is what somebody
      // reads before a progress meeting to see whose delay a wait actually was.
      permission: "methodology.prepare",
      group: "Operations",
      order: 43,
    },
    {
      label: "Projects",
      href: "/projects",
      icon: "folder-kanban",
      // §12's close-out checklist lives here. A project model has existed since session 1 with no
      // screen at all — the blockers are the first thing that made one necessary.
      permission: "project.view",
      group: "Operations",
      order: 40,
    },
    {
      label: "Warranty",
      href: "/warranty",
      icon: "shield-check",
      // §11's claims and the installed base they are read against. §11: "Warranty cost that nobody
      // totals is warranty cost that never gets fixed" — a total nobody can reach is one nobody
      // totals, so it gets a nav entry rather than living inside a ticket.
      permission: "warranty.determine",
      group: "Operations",
      order: 46,
    },
  ],
});
