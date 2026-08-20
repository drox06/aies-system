import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  buildCsv,
  checkRepeat,
  contentHash,
  type ExportDataset,
  type ExportPreset,
} from "@/server/core/finance/export-rules";

export const ACCOUNTING_EXPORT_ENTITY_TYPE = "AccountingExport";
export const ACCOUNTING_EXPORT_DOCUMENT_TYPE = "accounting_export";

/**
 * §8's accounting export — the period's figures, in the accountant's layout, recorded once.
 *
 * ## Two calls, deliberately
 *
 * `previewExportService` builds the file and says whether this period has been exported before.
 * `recordExportService` writes the run. Nothing is recorded by looking.
 *
 * Combining them would mean opening the screen counted as an export, and then the *"was this period
 * already exported"* answer would be yes because you had just asked the question. The separation is
 * what lets somebody check before committing, which is the whole point of warning rather than
 * refusing.
 */

/**
 * The rows for a dataset over a period, flattened to the field names the presets map from.
 *
 * Flattened here rather than in the preset because the presets are **column mappings**, and a mapping
 * that also had to know how to reach `payment.account.name` would be a query in disguise. Field names
 * are flat strings; the shape they came from is this function's problem.
 */
async function rowsFor(
  dataset: ExportDataset,
  periodStart: Date,
  periodEnd: Date,
): Promise<Record<string, unknown>[]> {
  if (dataset === "invoices") {
    /*
      Cancelled invoices are excluded but their numbers are not reused — §3 keeps a cancelled BIR
      number in the series deliberately, because a gap nobody can explain is worse than a void entry.
      They are simply not revenue, so they do not belong in an export the accountant posts.
    */
    const rows = await db.serviceInvoice.findMany({
      where: { status: { not: "cancelled" }, invoiceDate: { gte: periodStart, lte: periodEnd } },
      orderBy: { invoiceDate: "asc" },
    });
    const accounts = await db.customerAccount.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.accountId))] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(accounts.map((account) => [account.id, account.name]));
    return rows.map((row) => ({
      number: row.number,
      issuedAt: row.invoiceDate,
      accountName: nameById.get(row.accountId) ?? "",
      // Integer centavos throughout §3 — divided once, here, so no preset has to know.
      netAmount: ((row.grossAmount - row.vatAmount) / 100).toFixed(2),
      vatAmount: (row.vatAmount / 100).toFixed(2),
      withholdingAmount: (row.withholdingTaxAmount / 100).toFixed(2),
      totalAmount: (row.grossAmount / 100).toFixed(2),
      // §3 issues in pesos only; the column stays so a preset does not need two shapes.
      currency: "PHP",
    }));
  }

  if (dataset === "payments") {
    /*
      Bounced payments are out. A cheque that did not clear is money that never arrived, and posting
      it would tell the accounts the company was paid — §3 already treats a post-dated cheque as not
      cash until it clears, and this is the same rule at the export boundary.
    */
    const rows = await db.payment.findMany({
      where: { bouncedAt: null, receivedAt: { gte: periodStart, lte: periodEnd } },
      orderBy: { receivedAt: "asc" },
    });
    const accounts = await db.customerAccount.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.accountId))] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(accounts.map((account) => [account.id, account.name]));
    return rows.map((row) => ({
      reference: row.reference ?? row.number,
      receivedAt: row.receivedAt,
      accountName: nameById.get(row.accountId) ?? "",
      method: row.method,
      amount: (row.amount / 100).toFixed(2),
      currency: row.currency,
    }));
  }

  if (dataset === "expenses") {
    const rows = await db.expense.findMany({
      where: {
        deletedAt: null,
        status: { in: ["approved", "paid"] },
        expenseDate: { gte: periodStart, lte: periodEnd },
      },
      orderBy: { expenseDate: "asc" },
    });
    const projects = await db.project.findMany({
      where: {
        id: {
          in: [...new Set(rows.map((row) => row.projectId).filter((id): id is string => !!id))],
        },
      },
      select: { id: true, code: true },
    });
    const codeById = new Map(projects.map((project) => [project.id, project.code]));
    return rows.map((row) => ({
      number: row.number,
      expenseDate: row.expenseDate,
      vendorName: row.vendorName ?? "",
      category: row.category,
      amount: row.amount.toString(),
      vatAmount: row.vatAmount?.toString() ?? "",
      projectCode: row.projectId ? (codeById.get(row.projectId) ?? "") : "",
    }));
  }

  const rows = await db.supplierInvoice.findMany({
    where: {
      deletedAt: null,
      status: { in: ["approved", "paid"] },
      invoiceDate: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { invoiceDate: "asc" },
  });
  const suppliers = await db.supplier.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.supplierId))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  return rows.map((row) => ({
    number: row.number,
    supplierRef: row.supplierRef,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate ?? "",
    supplierName: nameById.get(row.supplierId) ?? "",
    amount: row.amount.toString(),
    vatAmount: row.vatAmount?.toString() ?? "",
  }));
}

function assertPeriod(periodStart: Date, periodEnd: Date) {
  if (periodEnd < periodStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The period ends before it starts. Check the dates.",
    });
  }
}

export async function previewExportService(input: {
  dataset: ExportDataset;
  preset: ExportPreset;
  periodStart: Date;
  periodEnd: Date;
}) {
  assertPeriod(input.periodStart, input.periodEnd);

  const rows = await rowsFor(input.dataset, input.periodStart, input.periodEnd);
  const csv = buildCsv(input.preset, input.dataset, rows);
  const hash = contentHash(csv);

  /*
    Previous runs of this dataset over this exact period.

    Matched on the dates rather than on overlap: a September export and a Q3 export cover some of the
    same invoices and are both legitimate, and warning about the second because it touches the first
    would make the warning noise. What §8 is guarding against is the *same* period posted twice.
  */
  const previous = await db.accountingExport.findMany({
    where: {
      dataset: input.dataset,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
    select: { contentHash: true, exportedAt: true },
    orderBy: { exportedAt: "desc" },
  });

  return {
    csv,
    hash,
    rowCount: rows.length,
    repeat: checkRepeat(previous, hash),
  };
}

/**
 * Records that the period was exported.
 *
 * Takes the hash and row count the caller was shown rather than recomputing them: the record must
 * describe **the file the accountant received**, and rebuilding it here could disagree with what was
 * downloaded if a payment landed in the seconds between. A run recording something nobody has is
 * worse than no run.
 */
export async function recordExportService(
  actor: ActorMeta,
  input: {
    dataset: ExportDataset;
    preset: ExportPreset;
    periodStart: Date;
    periodEnd: Date;
    rowCount: number;
    contentHash: string;
  },
) {
  assertPeriod(input.periodStart, input.periodEnd);

  const number = await allocateNumber(ACCOUNTING_EXPORT_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const row = await tx.accountingExport.create({
      data: {
        number,
        dataset: input.dataset,
        preset: input.preset,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        rowCount: input.rowCount,
        contentHash: input.contentHash,
        exportedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: ACCOUNTING_EXPORT_ENTITY_TYPE,
      entityId: row.id,
      summary:
        `Exported ${input.rowCount} ${input.dataset.replace(/_/g, " ")} row(s) for ` +
        `${input.periodStart.toISOString().slice(0, 10)} to ` +
        `${input.periodEnd.toISOString().slice(0, 10)} in the ${input.preset} layout`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: created.id, number: created.number };
}

/** What has been exported, newest first — the answer to "did we already send August?" */
export async function exportHistoryService() {
  const rows = await db.accountingExport.findMany({
    orderBy: { exportedAt: "desc" },
    take: 100,
  });

  const names = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.exportedById))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(names.map((user) => [user.id, user.name]));

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    dataset: row.dataset,
    preset: row.preset,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    rowCount: row.rowCount,
    exportedAt: row.exportedAt,
    exportedBy: nameById.get(row.exportedById) ?? "somebody",
  }));
}
