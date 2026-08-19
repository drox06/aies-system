import { db } from "@/lib/db";

/**
 * specs/05-finance-billing.md §4 — the final billing gate.
 *
 * ## What this is protecting
 *
 * A final statement says: the work is finished, here is the balance. Send one before it is true and
 * the customer's engineer finds the gap, disputes the bill, and the money that was thirty days away
 * becomes ninety. §4's seven conditions are the things a customer can point at, and every one of
 * them is a fact some other module already owns.
 *
 * ## Reported, then blocked — in that order
 *
 * §4: "The gate is shown as a checklist on the statement draft, so finance sees exactly what is
 * missing **and who owns it**." So this returns every condition with its state and its owner, and
 * the service refuses on the same structure. A gate that only says "no" makes somebody go and ask
 * around, which is the coordination failure §2 exists to remove, reappearing at the last step.
 *
 * Each condition is evaluated **independently**. §11 asks for that by name: knowing all six things
 * that are missing is one conversation, and finding them one at a time is six.
 *
 * ## The order they are listed in
 *
 * Not the spec's order. The checklist is read by somebody deciding what to chase, so it runs
 * roughly from "somebody else has to finish work" to "somebody has to file a piece of paper" — the
 * expensive blockers first, because those are the ones worth a phone call this morning.
 */

export interface GateCondition {
  key: string;
  /** What has to be true, in the words somebody would use to chase it. */
  label: string;
  ok: boolean;
  /** Only when it is not ok: what is actually missing, named. */
  detail?: string;
  /** Who has to do something about it. §4 asks for this explicitly. */
  owner: string;
  /** True when the condition does not apply to this order at all — not the same as passing. */
  notApplicable?: boolean;
}

export interface FinalBillingGate {
  ok: boolean;
  conditions: GateCondition[];
  /** The blocking ones, for a message that does not make somebody read a table. */
  blockers: GateCondition[];
}

/**
 * Whether a final statement can be issued against this sales order.
 *
 * Takes the order rather than the project, because billing is against an order — and §4's first
 * condition allows for an order with no executable scope at all, which has no project to close.
 */
export async function finalBillingGate(salesOrderId: string): Promise<FinalBillingGate> {
  const order = await db.salesOrder.findFirst({
    where: { id: salesOrderId, deletedAt: null },
    select: {
      id: true,
      number: true,
      lines: { select: { id: true, requiresExecution: true, lineNo: true, description: true } },
    },
  });

  if (!order) {
    return {
      ok: false,
      conditions: [
        {
          key: "order",
          label: "The sales order exists",
          ok: false,
          detail: "That order no longer exists.",
          owner: "—",
        },
      ],
      blockers: [],
    };
  }

  const tickets = await db.ticket.findMany({
    where: { salesOrderId: order.id, deletedAt: null },
    select: { id: true, number: true, type: true, projectId: true, title: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);
  const projectIds = [
    ...new Set(tickets.map((t) => t.projectId).filter((id): id is string => !!id)),
  ];

  const hasExecutableScope = order.lines.some((line) => line.requiresExecution);

  const conditions: GateCondition[] = [];

  // ---- 1. the project is closed ------------------------------------------------------------------
  //
  // §4 allows "or the order has no executable scope": a goods-only order has nothing to close, and
  // demanding a closed project for one would block every delivery the company ever bills.
  if (!hasExecutableScope) {
    conditions.push({
      key: "project_closed",
      label: "The project is closed",
      ok: true,
      notApplicable: true,
      detail: "Nothing on this order needs somebody on site, so there is no project to close.",
      owner: "—",
    });
  } else {
    const projects = await db.project.findMany({
      where: { id: { in: projectIds }, deletedAt: null },
      select: { id: true, code: true, status: true },
    });
    const open = projects.filter((project) => project.status !== "closed");
    conditions.push({
      key: "project_closed",
      label: "The project is closed",
      ok: projects.length > 0 && open.length === 0,
      detail:
        projects.length === 0
          ? "No project has been raised for this order's execution work."
          : open.length > 0
            ? `Still open: ${open.map((p) => `${p.code} (${p.status.replace(/_/g, " ")})`).join(", ")}`
            : undefined,
      owner: "Operations",
    });
  }

  // ---- 2. every service report is approved -------------------------------------------------------
  const reports = await db.serviceReport.findMany({
    where: { ticketId: { in: ticketIds }, deletedAt: null },
    select: { id: true, number: true, status: true, ticketId: true },
  });
  const unapprovedReports = reports.filter((report) => report.status !== "approved");
  const ticketsWithoutReport = hasExecutableScope
    ? tickets.filter(
        (ticket) =>
          ticket.type !== "delivery" && !reports.some((report) => report.ticketId === ticket.id),
      )
    : [];

  conditions.push({
    key: "service_reports",
    label: "Every service report is approved",
    ok: unapprovedReports.length === 0 && ticketsWithoutReport.length === 0,
    detail:
      ticketsWithoutReport.length > 0
        ? `No report yet on ${ticketsWithoutReport.map((t) => t.number).join(", ")}`
        : unapprovedReports.length > 0
          ? `Not approved: ${unapprovedReports.map((r) => `${r.number} (${r.status.replace(/_/g, " ")})`).join(", ")}`
          : undefined,
    owner: "Operations",
  });

  // ---- 3 and 7. QA passed, and the client approved it with evidence ------------------------------
  //
  // §4 lists these as separate conditions and they are: one is "the work is good", the other is
  // "the customer said so, in writing". The second is the stronger of the two for collections —
  // §4's own note calls the gate and the collection argument the same artefact — so a failed QA and
  // an unevidenced client approval are reported separately rather than folded together.
  const qa = await db.qAApproval.findMany({
    where: { ticketId: { in: ticketIds }, deletedAt: null },
    select: {
      id: true,
      number: true,
      approved: true,
      clientInspected: true,
      evidenceFileIds: true,
      ticketId: true,
    },
  });

  const failedQa = qa.filter((row) => !row.approved);
  conditions.push({
    key: "qa_passed",
    label: "QA has passed with nothing outstanding",
    ok: failedQa.length === 0,
    detail:
      failedQa.length > 0
        ? `Failed: ${failedQa.map((row) => row.number).join(", ")}`
        : qa.length === 0 && hasExecutableScope
          ? "No QA approval has been recorded."
          : undefined,
    owner: "Operations",
  });

  // §4: "The client has approved QA **and the evidence document is uploaded**."
  const withoutEvidence = qa.filter(
    (row) => row.approved && row.clientInspected && row.evidenceFileIds.length === 0,
  );
  conditions.push({
    key: "qa_client_evidence",
    label: "The client's own approval of QA is on file",
    ok: withoutEvidence.length === 0,
    detail:
      withoutEvidence.length > 0
        ? `Approved with no evidence document: ${withoutEvidence.map((row) => row.number).join(", ")}`
        : undefined,
    owner: "Operations",
  });

  // ---- 4. commissioning, where the scope included it ---------------------------------------------
  const tc = await db.testingCommissioning.findMany({
    where: { ticketId: { in: ticketIds }, deletedAt: null },
    select: { id: true, number: true, result: true, completedAt: true, signedAt: true },
  });

  if (tc.length === 0) {
    conditions.push({
      key: "commissioning",
      label: "Commissioning is signed off",
      ok: true,
      notApplicable: true,
      detail: "This order's scope did not include commissioning.",
      owner: "—",
    });
  } else {
    const unsigned = tc.filter((row) => row.result !== "accepted" || !row.signedAt);
    conditions.push({
      key: "commissioning",
      label: "Commissioning is signed off",
      ok: unsigned.length === 0,
      detail:
        unsigned.length > 0
          ? `Not accepted and signed: ${unsigned.map((row) => row.number).join(", ")}`
          : undefined,
      owner: "Operations",
    });
  }

  // ---- 5. cash advances liquidated ----------------------------------------------------------------
  //
  // Finance's own condition, and the only one on this list it owns. §5b calls unliquidated advances
  // "the most common quiet cash leak in a business of this shape" — billing a project whose advances
  // are still outstanding closes the file on money somebody still has in their pocket.
  const advances = await db.cashAdvance.findMany({
    where: {
      deletedAt: null,
      OR: [{ ticketId: { in: ticketIds } }, { projectId: { in: projectIds } }],
    },
    select: { id: true, number: true, status: true },
  });
  const outstanding = advances.filter(
    (advance) =>
      !["liquidated", "closed", "written_off", "rejected", "cancelled"].includes(advance.status),
  );
  conditions.push({
    key: "cash_advances",
    label: "Every cash advance is liquidated",
    ok: outstanding.length === 0,
    detail:
      outstanding.length > 0
        ? `Still open: ${outstanding.map((a) => `${a.number} (${a.status.replace(/_/g, " ")})`).join(", ")}`
        : undefined,
    owner: "Finance",
  });

  // ---- 6. the close-out pack, and the acceptance certificate --------------------------------------
  if (!hasExecutableScope) {
    conditions.push({
      key: "close_out",
      label: "The close-out pack exists",
      ok: true,
      notApplicable: true,
      detail: "No execution work, so there is no close-out pack.",
      owner: "—",
    });
  } else {
    const closeOuts = await db.projectCloseOut.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        status: true,
        customerAcceptanceRequired: true,
        customerAcceptanceFileId: true,
        acceptanceWaiverReason: true,
      },
    });

    const missing = projectIds.filter(
      (projectId) => !closeOuts.some((pack) => pack.projectId === projectId),
    );
    // §12's own rule: the acceptance certificate is required unless the customer's requirement was
    // explicitly waived with a reason. A waiver is an answer; a blank is not.
    const unaccepted = closeOuts.filter(
      (pack) =>
        pack.customerAcceptanceRequired &&
        !pack.customerAcceptanceFileId &&
        !pack.acceptanceWaiverReason,
    );

    conditions.push({
      key: "close_out",
      label: "The close-out pack exists, with the customer's acceptance",
      ok: missing.length === 0 && unaccepted.length === 0,
      detail:
        missing.length > 0
          ? "No close-out pack has been raised."
          : unaccepted.length > 0
            ? "The customer's acceptance certificate is not on file, and no waiver has been recorded."
            : undefined,
      owner: "Operations",
    });
  }

  // ---- 7. delivery receipts acknowledged ---------------------------------------------------------
  const receipts = await db.deliveryReceipt.findMany({
    where: { salesOrderId: order.id, deletedAt: null },
    select: { id: true, number: true, status: true },
  });

  if (receipts.length === 0) {
    conditions.push({
      key: "delivery_receipts",
      label: "Every delivery receipt is acknowledged",
      ok: true,
      notApplicable: true,
      detail: "Nothing was delivered against this order.",
      owner: "—",
    });
  } else {
    const unacknowledged = receipts.filter((receipt) => receipt.status !== "acknowledged");
    conditions.push({
      key: "delivery_receipts",
      label: "Every delivery receipt is acknowledged",
      ok: unacknowledged.length === 0,
      detail:
        unacknowledged.length > 0
          ? `Not acknowledged: ${unacknowledged.map((r) => `${r.number} (${r.status.replace(/_/g, " ")})`).join(", ")}`
          : undefined,
      owner: "Operations",
    });
  }

  const blockers = conditions.filter((condition) => !condition.ok);
  return { ok: blockers.length === 0, conditions, blockers };
}
