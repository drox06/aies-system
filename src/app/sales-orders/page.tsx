"use client";

import { useRouter } from "next/navigation";

import { useMemo, useState } from "react";
import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import {
  DataTable,
  DEFAULT_TABLE_STATE,
  type Column,
  type DataTableState,
} from "@/components/ui/data-table";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/03-order-procurement.md §1 — the obligations.
 *
 * §1 is the reason this screen shows four status columns instead of one: "Model this as a sales
 * order with **independent workstreams**, not a linear status chain. A single status field cannot
 * represent 'goods received, downpayment still unpaid, installation scheduled.'" A table with one
 * Status column would have to pick which of those three to tell you about, and would be wrong about
 * the other two.
 *
 * So procurement, finance and execution each get a column, and the overall status is a summary
 * beside them rather than instead of them.
 */

type Row = {
  id: string;
  number: string;
  orderDate: Date | string;
  requiredByDate: Date | string | null;
  currency: string;
  total: string;
  status: string;
  procurementStatus: string;
  financeStatus: string;
  executionStatus: string;
  account: { id: string; code: string; name: string } | null;
  customerPO: { poNumber: string } | null;
  _count: { lines: number };
};

const STATUS_TONE: Record<string, StatusTone> = {
  open: "active",
  in_progress: "active",
  partially_delivered: "pending",
  delivered: "approved",
  in_execution: "active",
  completed: "approved",
  closed: "draft",
  cancelled: "cancelled",
};

/**
 * The workstream columns read as *waiting* or *done*, never as failure.
 *
 * `not_required` is the quietest of all deliberately: an order with no field work is not an order
 * missing something, and colouring it like a gap would make every goods-only sale look wrong.
 */
const WORKSTREAM_TONE: Record<string, StatusTone> = {
  not_required: "draft",
  pending: "pending",
  ordered: "info",
  partially_received: "pending",
  received: "approved",
  awaiting_downpayment: "failed",
  downpayment_received: "info",
  partially_billed: "info",
  fully_billed: "info",
  paid: "approved",
  scheduled: "info",
  in_progress: "active",
  completed: "approved",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function SalesOrdersPage() {
  const router = useRouter();
  const [tableState, setTableState] = useState<DataTableState>({
    ...DEFAULT_TABLE_STATE,
    sortKey: "orderDate",
    sortDir: "desc",
  });

  const list = trpc.order.listSalesOrders.useQuery({ search: tableState.search || undefined });
  const all = useMemo(() => (list.data ?? []) as unknown as Row[], [list.data]);

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
      key: "number",
      header: "Order",
      width: "9rem",
      sortable: true,
      cell: (row) => <span className="tabular font-medium">{row.number}</span>,
      exportValue: (row) => row.number,
    },
    {
      key: "account",
      header: "Customer",
      sortable: true,
      cell: (row) => <span className="truncate">{row.account?.name ?? "—"}</span>,
      exportValue: (row) => row.account?.name ?? "",
    },
    {
      key: "total",
      header: "Value",
      align: "right",
      sortable: true,
      cell: (row) => <span className="tabular">{formatMoney(row.total, row.currency)}</span>,
      exportValue: (row) => row.total,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (row) => (
        <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
          <span className="capitalize">{human(row.status)}</span>
        </StatusBadge>
      ),
      exportValue: (row) => row.status,
    },
    {
      key: "procurementStatus",
      header: "Procurement",
      sortable: true,
      cell: (row) => <Workstream value={row.procurementStatus} />,
      exportValue: (row) => row.procurementStatus,
    },
    {
      key: "financeStatus",
      header: "Finance",
      sortable: true,
      cell: (row) => <Workstream value={row.financeStatus} />,
      exportValue: (row) => row.financeStatus,
    },
    {
      key: "executionStatus",
      header: "Execution",
      sortable: true,
      cell: (row) => <Workstream value={row.executionStatus} />,
      exportValue: (row) => row.executionStatus,
    },
    {
      key: "requiredByDate",
      header: "Required by",
      sortable: true,
      cell: (row) =>
        row.requiredByDate ? (
          <DateCell value={row.requiredByDate} />
        ) : (
          <span className="text-text-muted">—</span>
        ),
      exportValue: (row) =>
        row.requiredByDate ? new Date(row.requiredByDate).toISOString().slice(0, 10) : "",
    },
    {
      key: "customerPO",
      header: "Their PO",
      defaultHidden: true,
      cell: (row) => row.customerPO?.poNumber ?? <span className="text-text-muted">—</span>,
      exportValue: (row) => row.customerPO?.poNumber ?? "",
    },
    {
      key: "open",
      header: "",
      width: "5rem",
      cell: (row) => (
        <Link
          href={`/sales-orders/${row.id}`}
          className="text-sm text-blue-600 underline underline-offset-2"
        >
          Open
        </Link>
      ),
      exportValue: () => "",
    },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Sales orders"
        description="What AIES is committed to deliver, and where each commitment has got to."
      />

      {/*
        The row opens, not just the button at the end of it.

        Reaching an order meant travelling the whole width of a wide table to a link in the last
        column — a long mouse journey repeated all day, and on a laptop the column was often off
        screen entirely. The Open button stays for keyboard and for anybody who expects it.
      */}
      <DataTable
        columns={columns}
        rows={page}
        rowId={(row) => row.id}
        total={sorted.length}
        onRowClick={(row) => router.push(`/sales-orders/${row.id}`)}
        state={tableState}
        onStateChange={setTableState}
        isLoading={list.isPending}
        exportFilename="sales-orders"
        emptyState={
          <EmptyState
            title={tableState.search ? "No order matches that." : "No sales orders yet."}
            description={
              tableState.search
                ? "Search covers the order number and the customer's name."
                : "An order appears here when a verified customer PO is turned into one, from the quotation it answers."
            }
          />
        }
      />
    </div>
  );
}

function Workstream({ value }: { value: string }) {
  return (
    <StatusBadge tone={WORKSTREAM_TONE[value] ?? "draft"}>
      <span className="capitalize">{human(value)}</span>
    </StatusBadge>
  );
}

function sortValue(row: Row, key: string): string | number {
  switch (key) {
    case "number":
      return row.number;
    case "account":
      return row.account?.name.toLowerCase() ?? "";
    case "total":
      return Number(row.total);
    case "orderDate":
      return new Date(row.orderDate).getTime();
    case "requiredByDate":
      // Undated orders sort last either way rather than pretending to be due at the epoch.
      return row.requiredByDate ? new Date(row.requiredByDate).getTime() : Number.MAX_SAFE_INTEGER;
    case "status":
    case "procurementStatus":
    case "financeStatus":
    case "executionStatus":
      return row[key];
    default:
      return "";
  }
}
