"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DateCell, MoneyCell } from "@/components/ui/cells";
import {
  DataTable,
  DEFAULT_TABLE_STATE,
  type Column,
  type DataTableState,
} from "@/components/ui/data-table";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { humanQuotationStatus } from "@/server/core/quotation/quotation-lifecycle";
import { trpc } from "@/lib/trpc/client";
import { QuotationDialog } from "./QuotationDialog";

type QuotationRow = {
  id: string;
  displayNumber: string;
  quoteType: string;
  title: string;
  status: string;
  currency: string;
  total: string;
  validUntil: string;
  account: { id: string; code: string; name: string } | null;
};

/**
 * specs/02-quotation.md §2's statuses on the §6.4 badge scale.
 *
 * `sent` and `under_negotiation` are `active` blue: they are live documents with a customer, which
 * is the state this module exists to manage. `expired` is `failed` rather than `cancelled` — a
 * quotation that lapsed is a lost opportunity somebody could have prevented, not a tidy ending.
 */
const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "approved",
  sent: "active",
  under_negotiation: "active",
  accepted: "approved",
  rejected: "failed",
  expired: "failed",
  superseded: "cancelled",
  cancelled: "cancelled",
};

export default function QuotationsPage() {
  const router = useRouter();
  const [state, setState] = useState<DataTableState>(DEFAULT_TABLE_STATE);
  const [dialogOpen, setDialogOpen] = useState(false);

  const list = trpc.quotation.list.useQuery({
    search: state.search || undefined,
    page: state.page,
    pageSize: state.pageSize,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });

  const columns = useMemo<Column<QuotationRow>[]>(
    () => [
      {
        key: "number",
        header: "Number",
        sortable: true,
        width: "12rem",
        cell: (row) => (
          <div className="min-w-0">
            <p className="tabular font-medium">{row.displayNumber}</p>
            <p className="text-xs text-text-muted">
              {row.quoteType === "indent" ? "Indent" : "Local"}
            </p>
          </div>
        ),
        exportValue: (row) => row.displayNumber,
      },
      {
        key: "title",
        header: "Quotation",
        sortable: true,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.title}</p>
            {row.account && (
              <p className="truncate text-xs text-text-muted">
                {row.account.name} · {row.account.code}
              </p>
            )}
          </div>
        ),
        exportValue: (row) => row.title,
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        cell: (row) => (
          <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
            <span className="capitalize">{humanQuotationStatus(row.status)}</span>
          </StatusBadge>
        ),
        exportValue: (row) => row.status,
      },
      {
        key: "total",
        header: "Total",
        sortable: true,
        align: "right",
        cell: (row) => <MoneyCell value={row.total} currency={row.currency} />,
        exportValue: (row) => row.total,
      },
      {
        key: "validUntil",
        header: "Valid until",
        sortable: true,
        cell: (row) => {
          // §7 auto-expires past this date. Showing it in red beforehand is the only chance
          // anybody has to extend it while the customer still cares.
          const lapsed = new Date(row.validUntil) < new Date();
          const live = row.status === "sent" || row.status === "under_negotiation";
          return (
            <span className={lapsed && live ? "text-danger" : undefined}>
              <DateCell value={row.validUntil} />
            </span>
          );
        },
        exportValue: (row) => row.validUntil,
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/quotations/${row.id}`} onClick={(e) => e.stopPropagation()}>
              Open
            </Link>
          </Button>
        ),
        exportValue: () => "",
      },
    ],
    [],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Quotations"
        description="Every quotation AIES has prepared, and where each one stands."
        actions={<Button onClick={() => setDialogOpen(true)}>New quotation</Button>}
      />

      <DataTable<QuotationRow>
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as QuotationRow[]}
        total={list.data?.total ?? 0}
        rowId={(row) => row.id}
        state={state}
        onStateChange={setState}
        isLoading={list.isPending}
        exportFilename="aies-quotations"
        onRowClick={(row) => router.push(`/quotations/${row.id}`)}
        emptyState={
          <EmptyState
            title={state.search ? "No quotations match that search." : "No quotations yet."}
            description={
              state.search
                ? "Number, title and account name are all searched."
                : "Quotations are usually created for you when an inquiry reaches quoting — or start one here."
            }
            action={
              state.search ? null : (
                <Button onClick={() => setDialogOpen(true)}>New quotation</Button>
              )
            }
          />
        }
      />

      <QuotationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(id) => router.push(`/quotations/${id}`)}
      />
    </div>
  );
}
