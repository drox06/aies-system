import { db } from "../src/lib/db";
import { parseFormat } from "../src/server/core/numbering/format";

/**
 * Restarts the document counters after clearing sample data.
 *
 * Spec.md §5 says numbers are "never reused, never reordered", which is a rule about a **live**
 * system: a number that reached a customer must never appear again. Numbers burned on demo records
 * that have just been deleted never reached anybody, and leaving the next real quotation at
 * AIESLQ260442 would make the company's first document look like their four-hundredth.
 *
 * **A counter is never lowered past a number that still exists.** Restarting the account series to
 * zero while `ACC-0001` is still on the books would hand the next account a code the database
 * refuses. So each counter is set to the highest number actually in use, which is zero once the
 * series is empty and exactly right when it is not.
 *
 * Pass `--apply`. Without it this only reports.
 */

/**
 * Document types that legitimately have no records to protect — nothing in the database issues them
 * yet, so a counter for one can safely go to zero.
 *
 * **Declared explicitly rather than falling through a `default`.** This switch used to end in
 * `default: return 0`, which is indistinguishable from "this type has no rows" and has silently
 * offered to reset a live counter **twice**: once for `supplier_rfq` while `RFQ-26-0001` was on the
 * books, and again for module 03's three series. A forgotten case must fail loudly, so anything not
 * in the switch and not in this list now throws.
 *
 * When a module starts issuing one of these, delete it from here and add a case — the throw is what
 * makes that impossible to forget.
 */
const NOT_YET_ISSUED = new Set([
  "ticket",
  "cash_advance",
  "material_request",
  "methodology",
  "delivery_receipt",
  "service_report",
  "billing_statement",
  "service_invoice",
  "calibration_job",
  "ncr",
  "controlled_doc",
]);

/** The counter a series must not go below, given the rows still present. */
async function highestInUse(documentType: string): Promise<number> {
  const tail = (value: string) => Number(value.slice(-4));

  if (NOT_YET_ISSUED.has(documentType)) return 0;

  switch (documentType) {
    case "account": {
      const rows = await db.customerAccount.findMany({ select: { code: true } });
      return rows.reduce((max, r) => Math.max(max, tail(r.code) || 0), 0);
    }
    case "inquiry": {
      const rows = await db.inquiry.findMany({ select: { number: true } });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    case "quotation_local":
    case "quotation_indent": {
      const prefix = documentType === "quotation_local" ? "AIESLQ" : "AIESIQ";
      const rows = await db.quotation.findMany({
        // Deleted quotations do not hold the counter up: a number nobody can see is not in use.
        //
        // The honest caveat, printed by `main` rather than buried here — the row keeps its number in
        // the unique index, so a counter reset below a deleted number will eventually climb back
        // into it. That is thousands of quotations away, and the alternative (holding every future
        // number hostage to a test record somebody deleted) is worse.
        where: { number: { startsWith: prefix }, deletedAt: null },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    case "supplier_rfq": {
      // Added after a dry run offered to reset this counter to 0 while `RFQ-26-0001` was still on
      // the books — the next request would have been handed a number that already exists. The
      // `default` below is not a safe fallback for a series that has rows; it is only safe for one
      // that has none, and the two are indistinguishable from here without a case.
      const rows = await db.supplierQuoteRequest.findMany({
        where: { deletedAt: null },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    // Module 03's three series, added with the 2026-08-16 house-format rename for the same reason
    // `supplier_rfq` was: the `default` below is safe only for a series with no rows, and from here
    // that is indistinguishable from a series this switch has simply forgotten. A missing case does
    // not fail loudly — it silently offers to reset a live counter to zero.
    case "supplier": {
      const rows = await db.supplier.findMany({
        where: { deletedAt: null },
        select: { code: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.code) || 0), 0);
    }
    case "sales_order": {
      const rows = await db.salesOrder.findMany({
        where: { deletedAt: null },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    case "supplier_po": {
      const rows = await db.supplierPO.findMany({
        where: { deletedAt: null },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    case "goods_receipt": {
      const rows = await db.goodsReceipt.findMany({
        where: { deletedAt: null },
        select: { number: true },
      });
      return rows.reduce((max, r) => Math.max(max, tail(r.number) || 0), 0);
    }
    default:
      // Never `return 0`. See NOT_YET_ISSUED — a forgotten case and an empty series look identical
      // from here, and guessing wrong resets a counter below numbers that are on real documents.
      throw new Error(
        `reset-numbering-counters has no rule for document type "${documentType}", so it cannot ` +
          `tell whether the series is empty or whether it simply has not been taught about it. ` +
          `Add a case reading the highest number in use, or add it to NOT_YET_ISSUED if nothing ` +
          `issues one yet.`,
      );
  }
}

/**
 * The scope key today's format would produce for a document type.
 *
 * Load-bearing whenever a format's *shape* changes, not just its prefix. The 2026-08-16 rename
 * dropped the month from the inquiry format, so its counter moved from scope `26:08` to `26` — and
 * a scope with no row starts at zero. Fixing only the rows that already exist would have left the
 * next inquiry to be handed `AIESINQ-260001`, which was already on a record.
 *
 * Returns null for a format needing `extra` tokens (module 07's controlled documents), which have
 * no single current scope to compute.
 */
async function currentScopeKey(documentType: string, now: Date): Promise<string | null> {
  const row = await db.numberingFormat.findUnique({ where: { documentType } });
  if (!row) return null;
  try {
    return parseFormat(row.format, now).scopeParts.join(":");
  } catch {
    return null;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  const sequences = await db.documentSequence.findMany({ orderBy: { documentType: "asc" } });

  const plan: {
    id: string | null;
    documentType: string;
    scopeKey: string;
    from: number;
    to: number;
  }[] = [];
  for (const seq of sequences) {
    const floor = await highestInUse(seq.documentType);
    plan.push({
      id: seq.id,
      documentType: seq.documentType,
      scopeKey: seq.scopeKey,
      from: seq.counter,
      to: floor,
    });
  }

  // Any document type whose *current* scope has no row yet — including one whose format just
  // changed shape underneath it.
  const formats = await db.numberingFormat.findMany({ select: { documentType: true } });
  for (const { documentType } of formats) {
    const scopeKey = await currentScopeKey(documentType, now);
    if (scopeKey === null) continue;
    if (plan.some((p) => p.documentType === documentType && p.scopeKey === scopeKey)) continue;

    const floor = await highestInUse(documentType);
    if (floor === 0) continue; // Nothing in use, so an absent row is already correct.
    plan.push({ id: null, documentType, scopeKey, from: 0, to: floor });
  }

  for (const row of plan) {
    const note = row.to > 0 ? `  (held at ${row.to} — that number is still in use)` : "";
    const isNew = row.id === null ? "  [new scope]" : "";
    console.log(
      `${row.documentType.padEnd(20)} ${row.scopeKey.padEnd(8)} ${row.from} → ${row.to}${note}${isNew}`,
    );
  }

  const deleted = await db.quotation.findMany({
    where: { deletedAt: { not: null } },
    select: { number: true },
    orderBy: { number: "asc" },
  });
  if (deleted.length > 0) {
    console.log(
      `\nStill occupied in the unique index by deleted quotations: ` +
        `${[...new Set(deleted.map((d) => d.number))].join(", ")}. ` +
        `The counter would collide with these if it ever climbed back to them.`,
    );
  }

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  // The format each counter is now correct for. Stamping it is what clears `allocateNumber`'s
  // format guard — without this the guard would refuse forever after a rename, because the rows
  // would still claim the old shape.
  const formatByType = new Map(
    (await db.numberingFormat.findMany({ select: { documentType: true, format: true } })).map(
      (row) => [row.documentType, row.format],
    ),
  );

  for (const row of plan) {
    const format = formatByType.get(row.documentType) ?? null;
    if (row.id === null) {
      await db.documentSequence.create({
        data: {
          documentType: row.documentType,
          scopeKey: row.scopeKey,
          counter: row.to,
          format,
        },
      });
      continue;
    }
    await db.documentSequence.update({
      where: { id: row.id },
      data: { counter: row.to, format },
    });
  }
  console.log("\nCounters reset, and each stamped with the format it is now correct for.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
