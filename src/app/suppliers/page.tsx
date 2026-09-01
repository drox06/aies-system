"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import {
  DataTable,
  DEFAULT_TABLE_STATE,
  type Column,
  type DataTableState,
} from "@/components/ui/data-table";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { supplierApprovalState } from "@/server/core/order/supplier-rules";
import { trpc } from "@/lib/trpc/client";
import { PrincipalPipeline } from "../crm/principals/PrincipalPipeline";
import { SupplierDialog } from "./SupplierDialog";
import { SupplierPanel } from "./SupplierPanel";

/**
 * specs/03-order-procurement.md §2 and §5c, on one screen — the company's own instruction
 * (2026-09-01): *"make the Principals and Suppliers into one button. inside it, Principals' table
 * is on the top, while Suppliers' table is on the bottom."*
 *
 * ## The bug this closes
 *
 * Before this, "Principals" was a completely different screen reading a completely different
 * model — the §5c courting pipeline (`PrincipalProspect`), not `Supplier` at all. Ticking "this is a
 * principal" on the supplier form set `Supplier.isPrincipal = true`, which the old Suppliers screen
 * could filter to but which never appeared anywhere called "Principals" — there was nowhere for it
 * to appear. That is the company's own bug report, verbatim: *"when adding suppliers, if it was
 * tagged as principal then put it at the principal table... in previous test, all is placed in
 * suppliers, nothing is on principals even though it was tagged as principal."*
 *
 * The fix is definitional, not a new merge: **the Principals table below simply *is*
 * `Supplier.isPrincipal = true`.** One fetch, split client-side into two tables by that one column
 * — the same split the old Suppliers screen already offered as a togglable filter, now permanent
 * and visible as two tables rather than one table with a switch.
 *
 * The `PrincipalPipeline` (prospects still being courted, not yet a `Supplier` at all) sits between
 * the two tables, collapsed by default — a real, separate concept from either table, kept on this
 * same screen because it is still "Principals" work, and reachable without leaving the page.
 */

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  isPrincipal: boolean;
  isApproved: boolean;
  approvalExpiry: Date | string | null;
  country: string | null;
  currency: string;
  productLines: string[];
  leadTimeDaysTypical: number | null;
  paymentTerms: string | null;
  incoterm: string | null;
  rating: number | null;
};

export default function PrincipalsAndSuppliersPage() {
  const utils = trpc.useUtils();
  const [principalsPipelineOpen, setPrincipalsPipelineOpen] = useState(false);
  const [principalsState, setPrincipalsState] = useState<DataTableState>({
    ...DEFAULT_TABLE_STATE,
    sortKey: "name",
  });
  const [suppliersState, setSuppliersState] = useState<DataTableState>({
    ...DEFAULT_TABLE_STATE,
    sortKey: "name",
  });
  // `defaultIsPrincipal` decides which table's "Add" button opened it; `undefined` means closed.
  const [dialog, setDialog] = useState<{ id: string | null; defaultIsPrincipal: boolean } | null>(
    null,
  );
  const [openId, setOpenId] = useState<string | null>(null);

  // One fetch for the whole directory — "a few hundred suppliers at most" (the original screen's
  // own reasoning), split client-side by the one column that decides which table a row is in.
  const list = trpc.order.listSuppliers.useQuery({});
  const all = useMemo(() => (list.data ?? []) as SupplierRow[], [list.data]);

  const principalRows = useMemo(
    () =>
      filterAndSort(
        all.filter((r) => r.isPrincipal),
        principalsState,
      ),
    [all, principalsState],
  );
  const supplierRows = useMemo(
    () =>
      filterAndSort(
        all.filter((r) => !r.isPrincipal),
        suppliersState,
      ),
    [all, suppliersState],
  );

  const principalsPage = paginate(principalRows, principalsState);
  const suppliersPage = paginate(supplierRows, suppliersState);

  const columns = useMemo<Column<SupplierRow>[]>(() => buildColumns(), []);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Principals & Suppliers"
        description="Who AIES buys from — manufacturers it represents, and everyone else."
      />

      <section className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Principals</h2>
          <Button size="sm" onClick={() => setDialog({ id: null, defaultIsPrincipal: true })}>
            Add principal
          </Button>
        </div>

        <DataTable
          columns={columns}
          rows={principalsPage}
          rowId={(row) => row.id}
          total={principalRows.length}
          state={principalsState}
          onStateChange={setPrincipalsState}
          isLoading={list.isPending}
          exportFilename="aies-principals"
          onRowClick={(row) => setOpenId(row.id)}
          emptyState={
            <EmptyState
              title={principalsState.search ? "No principal matches that." : "No principals yet."}
              description={
                principalsState.search
                  ? "Search covers the code, the name and the product lines."
                  : "Add one directly, or appoint a prospect from the pipeline below."
              }
              action={
                <Button onClick={() => setDialog({ id: null, defaultIsPrincipal: true })}>
                  Add principal
                </Button>
              }
            />
          }
        />

        <div className="mt-3">
          <Button variant="ghost" size="sm" onClick={() => setPrincipalsPipelineOpen((v) => !v)}>
            {principalsPipelineOpen ? "Hide prospect pipeline" : "Show prospect pipeline"}
          </Button>
        </div>

        {principalsPipelineOpen && (
          <div className="mt-3 rounded-md border border-border bg-surface p-4">
            <PrincipalPipeline />
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Suppliers</h2>
          <Button size="sm" onClick={() => setDialog({ id: null, defaultIsPrincipal: false })}>
            Add supplier
          </Button>
        </div>

        <DataTable
          columns={columns}
          rows={suppliersPage}
          rowId={(row) => row.id}
          total={supplierRows.length}
          state={suppliersState}
          onStateChange={setSuppliersState}
          isLoading={list.isPending}
          exportFilename="aies-suppliers"
          onRowClick={(row) => setOpenId(row.id)}
          emptyState={
            <EmptyState
              title={suppliersState.search ? "No supplier matches that." : "No suppliers yet."}
              description={
                suppliersState.search
                  ? "Search covers the code, the name and the product lines."
                  : "Add the first one. Only a name is required — everything else can follow."
              }
              action={
                <Button onClick={() => setDialog({ id: null, defaultIsPrincipal: false })}>
                  Add supplier
                </Button>
              }
            />
          }
        />
      </section>

      {dialog !== null && (
        <SupplierDialog
          supplierId={dialog.id}
          defaultIsPrincipal={dialog.defaultIsPrincipal}
          onClose={() => setDialog(null)}
          onSaved={() => {
            void list.refetch();
            // The panel this dialog was opened from (`onEdit`) stays mounted underneath it, holding
            // its own `getSupplier` query — without this, closing the dialog reveals the panel's
            // pre-edit snapshot until something else happens to invalidate it.
            void utils.order.getSupplier.invalidate();
          }}
        />
      )}
      {openId && (
        <SupplierPanel
          supplierId={openId}
          onClose={() => setOpenId(null)}
          onEdit={() => {
            const row = all.find((r) => r.id === openId);
            setDialog({ id: openId, defaultIsPrincipal: row?.isPrincipal ?? false });
          }}
          onChanged={() => void list.refetch()}
        />
      )}
    </div>
  );
}

function buildColumns(): Column<SupplierRow>[] {
  return [
    {
      key: "code",
      header: "Code",
      width: "7rem",
      sortable: true,
      cell: (row) => <span className="tabular text-xs text-text-muted">{row.code}</span>,
      exportValue: (row) => row.code,
    },
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (row) => <span className="truncate font-medium">{row.name}</span>,
      exportValue: (row) => row.name,
    },
    {
      key: "approval",
      header: "Clause 8.4",
      sortable: true,
      cell: (row) => <ApprovalBadge row={row} />,
      exportValue: (row) => supplierApprovalState(row),
    },
    {
      key: "country",
      header: "Country",
      sortable: true,
      cell: (row) => row.country ?? <span className="text-text-muted">—</span>,
      exportValue: (row) => row.country ?? "",
    },
    {
      key: "productLines",
      header: "Product lines",
      cell: (row) =>
        row.productLines.length > 0 ? (
          <span className="truncate text-xs">{row.productLines.join(", ")}</span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
      exportValue: (row) => row.productLines.join(", "),
    },
    {
      key: "leadTimeDaysTypical",
      header: "Lead time",
      align: "right",
      sortable: true,
      cell: (row) =>
        row.leadTimeDaysTypical ? (
          <span className="tabular">{row.leadTimeDaysTypical} d</span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
      exportValue: (row) => row.leadTimeDaysTypical ?? "",
    },
    {
      key: "currency",
      header: "Currency",
      defaultHidden: true,
      cell: (row) => <span className="tabular text-xs">{row.currency}</span>,
      exportValue: (row) => row.currency,
    },
    {
      key: "paymentTerms",
      header: "Payment terms",
      defaultHidden: true,
      cell: (row) => row.paymentTerms ?? <span className="text-text-muted">—</span>,
      exportValue: (row) => row.paymentTerms ?? "",
    },
    {
      key: "incoterm",
      header: "Incoterm",
      defaultHidden: true,
      cell: (row) => row.incoterm ?? <span className="text-text-muted">—</span>,
      exportValue: (row) => row.incoterm ?? "",
    },
    {
      key: "approvalExpiry",
      header: "Approval expires",
      defaultHidden: true,
      sortable: true,
      cell: (row) =>
        row.approvalExpiry ? (
          <DateCell value={row.approvalExpiry} />
        ) : (
          <span className="text-text-muted">—</span>
        ),
      exportValue: (row) =>
        row.approvalExpiry ? new Date(row.approvalExpiry).toISOString().slice(0, 10) : "",
    },
  ];
}

function ApprovalBadge({ row }: { row: SupplierRow }) {
  const state = supplierApprovalState(row);
  if (state === "approved") return <StatusBadge tone="approved">Approved</StatusBadge>;
  if (state === "expired") return <StatusBadge tone="failed">Approval expired</StatusBadge>;
  return <StatusBadge tone="draft">Not approved</StatusBadge>;
}

/** Both tables read from one fetch, so search and sort happen here rather than on the server —
 *  the same reasoning the original Suppliers screen already used for sort alone. */
function filterAndSort(rows: SupplierRow[], state: DataTableState): SupplierRow[] {
  const search = state.search.trim().toLowerCase();
  const filtered = search
    ? rows.filter(
        (row) =>
          row.name.toLowerCase().includes(search) ||
          row.code.toLowerCase().includes(search) ||
          row.productLines.some((line) => line.toLowerCase().includes(search)),
      )
    : rows;

  const key = state.sortKey;
  if (!key) return filtered;
  const direction = state.sortDir === "desc" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === bv) return 0;
    return av > bv ? direction : -direction;
  });
}

function paginate(rows: SupplierRow[], state: DataTableState): SupplierRow[] {
  const start = (state.page - 1) * state.pageSize;
  return rows.slice(start, start + state.pageSize);
}

function sortValue(row: SupplierRow, key: string): string | number {
  switch (key) {
    case "code":
      return row.code;
    case "name":
      return row.name.toLowerCase();
    case "approval":
      return supplierApprovalState(row);
    case "country":
      return row.country?.toLowerCase() ?? "";
    case "leadTimeDaysTypical":
      return row.leadTimeDaysTypical ?? Number.MAX_SAFE_INTEGER;
    case "approvalExpiry":
      return row.approvalExpiry ? new Date(row.approvalExpiry).getTime() : Number.MAX_SAFE_INTEGER;
    default:
      return "";
  }
}
