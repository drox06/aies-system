import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import {
  projectPnl,
  rateOn,
  timesheetCost,
  type CostCategory,
  type CostLine,
} from "@/server/core/finance/project-pnl-rules";

/**
 * §6's project P&L, assembled from the seven places cost is already captured.
 *
 * ## The one design decision worth arguing about
 *
 * Nothing here writes. Every figure is read from the record that owns it at the moment somebody
 * asks, rather than posted into a ledger as it happens.
 *
 * The alternative — a `ProjectCost` table that everything posts to — is what a bookkeeper would
 * expect, and it is wrong for this platform at this stage. It doubles every write path, it goes
 * stale the moment a source record is corrected, and it makes "why is this figure what it is"
 * unanswerable without a reconciliation. Reading through means a corrected timesheet corrects the
 * margin, and a manager who distrusts a number can follow it back to the row it came from.
 *
 * What it costs is speed on very large projects. When that becomes real, the fix is a materialised
 * snapshot **with** the live query kept as the thing it is checked against — not a ledger that has
 * become the only version of the truth.
 *
 * ## What is deliberately excluded
 *
 * Costs are counted only where somebody has approved them. A submitted expense, an unapproved
 * timesheet and an unreviewed liquidation are all **claims**; counting them would make a project
 * look worse the moment somebody typed something and better again when it was rejected.
 */

/** §6's categories, mapped from the vocabularies the source modules already use. */
const FIELD_EXPENSE_CATEGORY: Record<string, CostCategory> = {
  transport: "travel",
  fuel: "travel",
  meals: "travel",
  accommodation: "travel",
  materials: "materials",
  tools: "equipment",
  permits: "permits",
  other: "other",
};

const EXPENSE_CATEGORY: Record<string, CostCategory> = {
  subcontract: "subcontract",
  rental: "equipment",
  equipment: "equipment",
  permits: "permits",
  materials: "materials",
  travel: "travel",
  other: "other",
};

export async function projectPnlService(projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, code: true, name: true, accountId: true, status: true },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That project no longer exists." });
  }

  /*
    The contract value and the quoted cost come from the sales order, not the quotation.

    The order stores both at creation precisely so a later edit to the quotation cannot rewrite what
    the deal was worth — the same reasoning as docs/DECISIONS.md #32. Reading the quotation here
    would reintroduce that bug from the reporting side, where it would be even harder to notice.
  */
  const orders = await db.salesOrder.findMany({
    where: { deletedAt: null, tickets: { some: { projectId: project.id } } },
    select: { id: true, total: true, totalCost: true },
  });

  const contractValue = orders.reduce((sum, order) => sum + Number(order.total), 0);
  const quotedCost = orders.reduce((sum, order) => sum + Number(order.totalCost), 0);
  const orderIds = orders.map((order) => order.id);

  const tickets = await db.ticket.findMany({
    where: { projectId: project.id, deletedAt: null },
    select: { id: true, number: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);

  const costs: CostLine[] = [];

  // ---- 1. Supplier PO landed cost ---------------------------------------------------------------
  // Goods, freight and duties. §5 of module 03 spreads charges across lines by value; the totals
  // here are the PO's own, which already include them.
  const supplierPos = await db.supplierPO.findMany({
    where: { deletedAt: null, salesOrderId: { in: orderIds }, status: { not: "cancelled" } },
    select: { number: true, total: true },
  });
  for (const po of supplierPos) {
    costs.push({ category: "materials", amount: Number(po.total), source: po.number });
  }

  // ---- 2. Approved cash advance liquidation lines ------------------------------------------------
  // §5b: "Approved liquidation lines post as project costs automatically — they must not be re-keyed
  // as expenses." Reading them here is that, without a second write path to keep in step.
  const liquidations = await db.cashAdvanceLiquidation.findMany({
    where: {
      status: "approved",
      cashAdvance: {
        deletedAt: null,
        OR: [{ projectId: project.id }, { ticketId: { in: ticketIds } }],
      },
    },
    select: { lines: true, cashAdvance: { select: { number: true } } },
  });
  for (const liquidation of liquidations) {
    const lines = Array.isArray(liquidation.lines) ? liquidation.lines : [];
    for (const raw of lines as { category?: string; amount?: number }[]) {
      costs.push({
        category: FIELD_EXPENSE_CATEGORY[raw.category ?? "other"] ?? "other",
        amount: Number(raw.amount ?? 0),
        source: liquidation.cashAdvance.number,
      });
    }
  }

  // ---- 3. Field expenses not covered by an advance ------------------------------------------------
  // `cashAdvanceId: null` matters: an expense paid out of an advance is already counted above, and
  // counting it twice would show a project spending money it never spent.
  const fieldExpenses = await db.fieldExpense.findMany({
    where: {
      deletedAt: null,
      cashAdvanceId: null,
      status: "approved",
      OR: [{ projectId: project.id }, { ticketId: { in: ticketIds } }],
    },
    select: { category: true, amount: true, description: true },
  });
  for (const expense of fieldExpenses) {
    costs.push({
      category: FIELD_EXPENSE_CATEGORY[expense.category] ?? "other",
      // Field expenses are integer centavos — the platform's money rule everywhere it is not a
      // Decimal. Divided once, here, rather than at each reader.
      amount: expense.amount / 100,
      source: expense.description,
    });
  }

  // ---- 4. Labour from approved timesheets ----------------------------------------------------------
  const timesheets = await db.timesheet.findMany({
    where: {
      deletedAt: null,
      status: "approved",
      OR: [{ projectId: project.id }, { ticketId: { in: ticketIds } }],
    },
    select: {
      userId: true,
      date: true,
      regularHours: true,
      overtimeHours: true,
      travelHours: true,
      standbyHours: true,
    },
  });

  // `Timesheet` has no relation to `User`, so names are fetched rather than joined. Worth the extra
  // query: a cost line reading "R. Santos" is one somebody can check, and "cm7x…" is not.
  const workerNames = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(timesheets.map((sheet) => sheet.userId))] } },
        select: { id: true, name: true },
      })
    ).map((user) => [user.id, user.name]),
  );

  const rates = await db.costRate.findMany({
    where: { deletedAt: null, userId: { in: [...new Set(timesheets.map((t) => t.userId))] } },
    select: {
      userId: true,
      effectiveFrom: true,
      hourlyCost: true,
      overtimeMultiplier: true,
      travelMultiplier: true,
      standbyMultiplier: true,
    },
  });

  /*
    Days worked by somebody with no cost rate on file.

    Counted and reported rather than guessed at. §6 makes this the number management cannot get
    anywhere else, and an invented rate would put a fabricated figure into exactly that number.
    Saying "eleven days have no rate" sends somebody to fix the rates; quietly costing them at zero
    and saying nothing produces a margin that looks better than the job was.
  */
  let daysWithNoRate = 0;

  for (const sheet of timesheets) {
    const rate = rateOn(
      rates.filter((r) => r.userId === sheet.userId),
      sheet.date,
    );
    if (!rate) {
      daysWithNoRate += 1;
      continue;
    }
    const amount = timesheetCost(
      {
        regularHours: Number(sheet.regularHours),
        overtimeHours: Number(sheet.overtimeHours),
        travelHours: Number(sheet.travelHours),
        standbyHours: Number(sheet.standbyHours),
      },
      {
        hourlyCost: Number(rate.hourlyCost),
        overtimeMultiplier: Number(rate.overtimeMultiplier),
        travelMultiplier: Number(rate.travelMultiplier),
        standbyMultiplier: Number(rate.standbyMultiplier),
      },
    );
    if (amount > 0) {
      costs.push({ category: "labour", amount, source: workerNames.get(sheet.userId) ?? "labour" });
    }
  }

  // ---- 5. Materials issued from stock -------------------------------------------------------------
  /*
    `issue` and `consume` are the two that take stock out of the store towards a job. `return` puts it
    back and `adjustment` is a stocktake correction, neither of which is a project cost — a returned
    part the crew did not use must not be charged to the customer's job.

    Valued at the item's last purchase cost, as §6 asks. A movement whose item has no recorded cost
    is counted as **uncosted** rather than as free: the caveat below says how many, because a margin
    flattered by unpriced stock is exactly the failure this screen exists to prevent.
  */
  const movements = await db.stockMovement.findMany({
    where: { ticketId: { in: ticketIds }, type: { in: ["issue", "consume"] } },
    select: {
      quantity: true,
      stockItem: { select: { name: true, lastPurchaseCost: true } },
    },
  });

  let uncostedStockIssues = 0;
  for (const movement of movements) {
    const unitCost = movement.stockItem?.lastPurchaseCost;
    if (unitCost === null || unitCost === undefined) {
      uncostedStockIssues += 1;
      continue;
    }
    costs.push({
      category: "materials",
      amount: Number(movement.quantity) * Number(unitCost),
      source: movement.stockItem?.name ?? "stock",
    });
  }

  // ---- 6. Rework from failed QA rounds ------------------------------------------------------------
  /*
    §6 wants the cost of poor quality reportable on its own.

    What a failed QA round actually costs is the crew going back — labour and travel already counted
    above under their own categories. Splitting them out properly needs a link from a timesheet to
    the QA round that caused it, which module 04 does not record and should not be made to guess.

    So this counts the **rounds**, and the screen says how many there were rather than inventing a
    peso figure. A number nobody can defend is worse here than an honest count: §6 asks for this to
    be arguable, and "three failed rounds on this project" starts an argument that "₱48,000 of
    rework, we think" does not survive.
  */
  const failedQa = await db.qAApproval.count({
    where: { ticketId: { in: ticketIds }, approved: false },
  });

  // ---- 7. Direct expenses --------------------------------------------------------------------------
  const expenses = await db.expense.findMany({
    where: {
      deletedAt: null,
      status: { in: ["approved", "paid"] },
      OR: [{ projectId: project.id }, { salesOrderId: { in: orderIds } }],
    },
    select: { number: true, category: true, amount: true, vendorName: true },
  });
  for (const expense of expenses) {
    costs.push({
      category: EXPENSE_CATEGORY[expense.category] ?? "other",
      amount: Number(expense.amount),
      source: expense.vendorName ?? expense.number,
    });
  }

  const pnl = projectPnl({ contractValue, quotedCost, costs });

  return {
    project,
    ...pnl,
    /** What the figure does not know, said out loud rather than folded into it. */
    caveats: {
      daysWithNoRate,
      uncostedStockIssues,
      failedQaRounds: failedQa,
      /** True when no sales order was found — the margin is then meaningless, not zero. */
      noContractValue: orders.length === 0,
    },
  };
}
