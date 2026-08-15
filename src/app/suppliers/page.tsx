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
import { SupplierDialog } from "./SupplierDialog";
import { SupplierPanel } from "./SupplierPanel";

/**
 * specs/03-order-procurement.md §2 — the supplier directory.
 *
 * A table rather than a board, because unlike the principal pipeline nothing here is *in progress*.
 * The question this screen answers is "who do we buy this from, and are we allowed to" — a lookup,
 * which is what a searchable, sortable, exportable table is for.
 *
 * Two things earn a column of their own: whether a supplier is a principal (§5c's appointed
 * manufacturers, who arrive here by conversion rather than by typing) and whether they are approved
 * under ISO 9001 clause 8.4. The second is the one an auditor asks about, so it is a badge and not a
 * tick — "Approval expired" has to read differently from "not approved", because they mean opposite
 * things about whether anybody ever did the work.
 */

type Row = {
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

export default function SuppliersPage() {
  const [tableState, setTableState] = useState<DataTableState>({
    ...DEFAULT_TABLE_STATE,
    sortKey: "name",
  });
  const [principalsOnly, setPrincipalsOnly] = useState(false);
  const [dialogFor, setDialogFor] = useState<string | null | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = trpc.order.listSuppliers.useQuery({
    search: tableState.search || undefined,
    principalsOnly: principalsOnly || undefined,
  });

  const all = useMemo(() => (list.data ?? []) as Row[], [list.data]);

  // Sorting and paging happen here because the service returns the whole directory in one go — a
  // few hundred suppliers at most, and §2 wants this screen fast and forgiving rather than
  // paginated on the server for a dataset that fits in a response.
  const sorted = useMemo(() => {
    const rows = [...all];
    const key = tableState.sortKey;
    if (!key) return rows;
    const direction = tableState.sortDir === "desc" ? -1 : 1;
    return rows.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av === bv) return 0;
      return av > bv ? direction : -direction;
    });
  }, [all, tableState.sortKey, tableState.sortDir]);

  const start = (tableState.page - 1) * tableState.pageSize;
  const page = sorted.slice(start, start + tableState.pageSize);

  const columns: Column<Row>[] = [
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
      header: "Supplier",
      sortable: true,
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{row.name}</span>
          {row.isPrincipal && <StatusBadge tone="info">Principal</StatusBadge>}
        </span>
      ),
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

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Suppliers"
        description="Who AIES buys from. Only a name is required to add one — everything else can follow."
        actions={<Button onClick={() => setDialogFor(null)}>Add supplier</Button>}
      />

      <DataTable
        columns={columns}
        rows={page}
        rowId={(row) => row.id}
        total={sorted.length}
        state={tableState}
        onStateChange={setTableState}
        isLoading={list.isPending}
        exportFilename="suppliers"
        onRowClick={(row) => setOpenId(row.id)}
        filterChips={
          principalsOnly
            ? [
                {
                  key: "principals",
                  label: "Principals only",
                  onRemove: () => setPrincipalsOnly(false),
                },
              ]
            : []
        }
        emptyState={
          <EmptyState
            title={tableState.search ? "No supplier matches that." : "No suppliers yet."}
            description={
              tableState.search
                ? "Search covers the code, the name and the product lines."
                : "Add the first one. Appointed principals arrive here automatically when they are appointed."
            }
            action={<Button onClick={() => setDialogFor(null)}>Add supplier</Button>}
          />
        }
      />

      <div className="mt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPrincipalsOnly((value) => !value);
            setTableState((state) => ({ ...state, page: 1 }));
          }}
        >
          {principalsOnly ? "Show every supplier" : "Show principals only"}
        </Button>
      </div>

      {dialogFor !== undefined && (
        <SupplierDialog
          supplierId={dialogFor}
          onClose={() => setDialogFor(undefined)}
          onSaved={() => void list.refetch()}
        />
      )}
      {openId && (
        <SupplierPanel
          supplierId={openId}
          onClose={() => setOpenId(null)}
          onEdit={() => setDialogFor(openId)}
          onChanged={() => void list.refetch()}
        />
      )}
    </div>
  );
}

function ApprovalBadge({ row }: { row: Row }) {
  const state = supplierApprovalState(row);
  // Three states, three badges — see supplierApprovalState for why "expired" is not folded in.
  if (state === "approved") return <StatusBadge tone="approved">Approved</StatusBadge>;
  if (state === "expired") return <StatusBadge tone="failed">Approval expired</StatusBadge>;
  // "Not approved" and not "rejected": most suppliers in a fresh directory simply have not been
  // through clause 8.4 yet, and colouring that as a failure would make the screen read as broken.
  return <StatusBadge tone="draft">Not approved</StatusBadge>;
}

function sortValue(row: Row, key: string): string | number {
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
      // Unknown lead times sort last in either direction rather than pretending to be zero, which
      // would put every unfilled supplier at the top of a "fastest first" sort.
      return row.leadTimeDaysTypical ?? Number.MAX_SAFE_INTEGER;
    case "approvalExpiry":
      return row.approvalExpiry ? new Date(row.approvalExpiry).getTime() : Number.MAX_SAFE_INTEGER;
    default:
      return "";
  }
}
