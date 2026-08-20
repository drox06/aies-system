/**
 * §8's accounting export — the column mappings, and the guard against posting a month twice.
 *
 * §8 asks for four things: a configurable CSV export of invoices, payments, expenses and supplier
 * bills; QuickBooks and Xero layouts as presets; a column mapping the accountant defines; and export
 * runs recorded *"so the same period is not exported twice unnoticed."*
 *
 * That last clause is the one carrying the weight. **Double-posting a month is not caught by the
 * accounting package** — it balances perfectly and simply reports that the company earned twice what
 * it did. Nobody notices until a tax return looks wrong, by which time the correcting entries are
 * their own small project.
 *
 * Pure — no Prisma. On `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 */

export const EXPORT_DATASETS = ["invoices", "payments", "expenses", "supplier_bills"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export const EXPORT_DATASET_LABELS: Record<ExportDataset, string> = {
  invoices: "Service invoices",
  payments: "Payments received",
  expenses: "Expenses",
  supplier_bills: "Supplier bills",
};

export const EXPORT_PRESETS = ["generic", "quickbooks", "xero"] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/**
 * A column in the exported file: the header the accountant's package expects, and the field it comes
 * from.
 *
 * The mapping is data rather than code because §8 says the accountant defines it, and an accountant
 * who has to ask a developer to rename a column will keep doing the export by hand instead.
 */
export interface ExportColumn {
  header: string;
  field: string;
}

/**
 * The three layouts.
 *
 * `generic` is AIES's own field names, which is the one to use when the accountant is mapping by
 * hand in a spreadsheet — it is easier to map from a name you recognise than from somebody else's
 * schema.
 *
 * `quickbooks` and `xero` use each package's documented import headers. They are presets rather than
 * integrations: §8 asks for compatible layouts and explicitly does not ask for an API connection,
 * and a CSV somebody reviews before importing is a safer boundary than a live sync nobody watches.
 */
export const PRESET_COLUMNS: Record<ExportPreset, Record<ExportDataset, ExportColumn[]>> = {
  generic: {
    invoices: [
      { header: "invoice_number", field: "number" },
      { header: "invoice_date", field: "issuedAt" },
      { header: "customer", field: "accountName" },
      { header: "net", field: "netAmount" },
      { header: "vat", field: "vatAmount" },
      { header: "withholding", field: "withholdingAmount" },
      { header: "total", field: "totalAmount" },
      { header: "currency", field: "currency" },
    ],
    payments: [
      { header: "reference", field: "reference" },
      { header: "received_at", field: "receivedAt" },
      { header: "customer", field: "accountName" },
      { header: "method", field: "method" },
      { header: "amount", field: "amount" },
      { header: "currency", field: "currency" },
    ],
    expenses: [
      { header: "expense_number", field: "number" },
      { header: "expense_date", field: "expenseDate" },
      { header: "vendor", field: "vendorName" },
      { header: "category", field: "category" },
      { header: "amount", field: "amount" },
      { header: "vat", field: "vatAmount" },
      { header: "project", field: "projectCode" },
    ],
    supplier_bills: [
      { header: "bill_number", field: "number" },
      { header: "supplier_ref", field: "supplierRef" },
      { header: "invoice_date", field: "invoiceDate" },
      { header: "due_date", field: "dueDate" },
      { header: "supplier", field: "supplierName" },
      { header: "amount", field: "amount" },
      { header: "vat", field: "vatAmount" },
    ],
  },

  quickbooks: {
    invoices: [
      { header: "InvoiceNo", field: "number" },
      { header: "InvoiceDate", field: "issuedAt" },
      { header: "Customer", field: "accountName" },
      { header: "Amount", field: "netAmount" },
      { header: "TaxAmount", field: "vatAmount" },
      { header: "Currency", field: "currency" },
    ],
    payments: [
      { header: "RefNumber", field: "reference" },
      { header: "Date", field: "receivedAt" },
      { header: "Customer", field: "accountName" },
      { header: "Amount", field: "amount" },
    ],
    expenses: [
      { header: "RefNumber", field: "number" },
      { header: "Date", field: "expenseDate" },
      { header: "Payee", field: "vendorName" },
      { header: "Account", field: "category" },
      { header: "Amount", field: "amount" },
    ],
    supplier_bills: [
      { header: "BillNo", field: "number" },
      { header: "BillDate", field: "invoiceDate" },
      { header: "DueDate", field: "dueDate" },
      { header: "Vendor", field: "supplierName" },
      { header: "Amount", field: "amount" },
    ],
  },

  xero: {
    invoices: [
      { header: "*InvoiceNumber", field: "number" },
      { header: "*InvoiceDate", field: "issuedAt" },
      { header: "*ContactName", field: "accountName" },
      { header: "*UnitAmount", field: "netAmount" },
      { header: "TaxAmount", field: "vatAmount" },
      { header: "Currency", field: "currency" },
    ],
    payments: [
      { header: "Reference", field: "reference" },
      { header: "Date", field: "receivedAt" },
      { header: "*ContactName", field: "accountName" },
      { header: "Amount", field: "amount" },
    ],
    expenses: [
      { header: "Reference", field: "number" },
      { header: "*Date", field: "expenseDate" },
      { header: "*ContactName", field: "vendorName" },
      { header: "*Description", field: "category" },
      { header: "*UnitAmount", field: "amount" },
    ],
    supplier_bills: [
      { header: "*InvoiceNumber", field: "number" },
      { header: "*InvoiceDate", field: "invoiceDate" },
      { header: "*DueDate", field: "dueDate" },
      { header: "*ContactName", field: "supplierName" },
      { header: "*UnitAmount", field: "amount" },
    ],
  },
};

/**
 * One CSV field, escaped.
 *
 * Quotes everything containing a comma, a quote or a newline, and doubles internal quotes — RFC 4180.
 * A supplier called "Santos, Reyes & Co." is not an edge case in the Philippines, and an unescaped
 * comma silently shifts every column after it, which the receiving package imports without complaint.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Builds the CSV body for a dataset in a chosen layout. */
export function buildCsv(
  preset: ExportPreset,
  dataset: ExportDataset,
  rows: readonly Record<string, unknown>[],
): string {
  const columns = PRESET_COLUMNS[preset][dataset];
  const lines = [columns.map((column) => csvField(column.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(row[column.field])).join(","));
  }
  // Trailing newline: some importers drop the final row without one.
  return `${lines.join("\n")}\n`;
}

/**
 * A stable fingerprint of what was exported.
 *
 * §8 wants a period not exported twice *unnoticed* — and the important word is the last one. A second
 * export is often legitimate: the accountant lost the file, or a late invoice was added and the month
 * genuinely needs resending. What must not happen is somebody re-exporting an **unchanged** month
 * without realising, and posting it again.
 *
 * So the run records a hash of its own content. Re-running a period whose hash matches is a copy;
 * re-running one whose hash differs is a genuine change, and the screen can say which. That is a more
 * useful answer than a flat "already exported" refusal, which people work around by exporting to a
 * different filename.
 *
 * Deliberately not cryptographic. This detects accidental repetition, not tampering, and a
 * dependency-free hash keeps the export path free of a crypto import it does not otherwise need.
 */
export function contentHash(content: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export interface RepeatCheck {
  /** True when this exact period and dataset has been exported before. */
  seenBefore: boolean;
  /** True when it was exported before **and nothing has changed since**. */
  identical: boolean;
  message: string;
}

/**
 * Whether this export repeats one already done.
 *
 * Warns rather than refuses. Both repeats are legitimate in the right circumstances, and the job here
 * is to make sure nobody does either by accident.
 */
export function checkRepeat(
  previous: readonly { contentHash: string; exportedAt: Date | string }[],
  hash: string,
): RepeatCheck {
  if (previous.length === 0) {
    return { seenBefore: false, identical: false, message: "First export of this period." };
  }

  const same = previous.find((run) => run.contentHash === hash);
  const last = previous.reduce((newest, run) =>
    new Date(run.exportedAt) > new Date(newest.exportedAt) ? run : newest,
  );
  const when = new Date(last.exportedAt).toISOString().slice(0, 10);

  if (same) {
    return {
      seenBefore: true,
      identical: true,
      message:
        `This period was already exported on ${when} and nothing has changed since. Posting it ` +
        `again would double the month in the accounts.`,
    };
  }

  return {
    seenBefore: true,
    identical: false,
    message:
      `This period was exported on ${when}, and the figures have changed since. Post the difference ` +
      `or reverse the earlier entry — do not simply add this one on top.`,
  };
}
