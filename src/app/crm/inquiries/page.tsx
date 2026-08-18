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
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import { trpc } from "@/lib/trpc/client";
import { InquiryDialog } from "./InquiryDialog";

interface SlaView {
  dueAt: string;
  breached: boolean;
  escalatable: boolean;
  paused: boolean;
  remainingMs: number;
}

type InquiryRow = {
  id: string;
  number: string;
  subject: string;
  status: string;
  receivedAt: string;
  acknowledgedAt: string | null;
  estimatedValue: string | null;
  currency: string;
  requiredByDate: string | null;
  account: { id: string; code: string; name: string } | null;
  sla: SlaView;
};

/**
 * specs/01-crm-inquiry.md §3's lifecycle, on the §6.4 badge scale.
 *
 * `new` is `pending` orange rather than grey: it is the only status with a clock running against
 * it, and Spec.md §6.3 reserves orange for exactly the "needs your attention" case. Grey would put
 * the one state that can breach an SLA in the same visual bucket as a closed record.
 */
const STATUS_TONE: Record<string, StatusTone> = {
  new: "pending",
  acknowledged: "info",
  evaluating: "info",
  inspection_required: "pending",
  quoting: "active",
  quoted: "active",
  won: "approved",
  lost: "failed",
  disqualified: "cancelled",
};

/**
 * Live inquiries by default; the archive is its own screen.
 *
 * The list used to keep everything ever logged, mixed together, with no status filter on the screen
 * at all. Harmless at twenty rows and useless at two thousand — the screen somebody opens each
 * morning to see what needs attention would be mostly things that needed attention two years ago.
 * The company asked for the split, and quotations had already solved it the same way.
 */
/** Mirrors ARCHIVABLE_STATUSES in inquiry-service.ts, which is what actually enforces it. */
const ARCHIVABLE = ["po_received", "won", "lost", "disqualified"];

export default function InquiriesPage() {
  return <InquiryList archived={false} />;
}

export function InquiryList({ archived }: { archived: boolean }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const setArchived = trpc.crm.setInquiryArchived.useMutation({
    onSuccess: () => void utils.crm.listInquiries.invalidate(),
  });
  const [state, setState] = useState<DataTableState>(DEFAULT_TABLE_STATE);
  const [dialogOpen, setDialogOpen] = useState(false);

  const list = trpc.crm.listInquiries.useQuery({
    search: state.search || undefined,
    page: state.page,
    pageSize: state.pageSize,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
    archived,
  });

  const columns = useMemo<Column<InquiryRow>[]>(
    () => [
      {
        key: "number",
        header: "Number",
        sortable: true,
        width: "10rem",
        cell: (row) => <span className="tabular font-medium">{row.number}</span>,
        exportValue: (row) => row.number,
      },
      {
        key: "subject",
        header: "Inquiry",
        sortable: true,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.subject}</p>
            {row.account && (
              <p className="truncate text-xs text-text-muted">
                {row.account.name} · {row.account.code}
              </p>
            )}
          </div>
        ),
        exportValue: (row) => row.subject,
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        cell: (row) => (
          <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
            <span className="capitalize">{humanStatus(row.status)}</span>
          </StatusBadge>
        ),
        exportValue: (row) => row.status,
      },
      {
        // §6: the kanban card shows "a red flag if the SLA is breached". Same signal, in a table.
        key: "sla",
        header: "Acknowledgement",
        cell: (row) => {
          if (row.acknowledgedAt) {
            // Once the inquiry has moved past acknowledgement the SLA is history, not a live
            // problem — an inquiry sitting in `quoting` with a red "Acknowledged late" badge reads
            // as something needing action when there is nothing to do about it. The fact is kept,
            // because §3's whole point is that late acknowledgement should be visible, but it drops
            // to quiet text so it stops competing with the statuses that are still actionable.
            const settled = !["new", "acknowledged"].includes(row.status);
            if (settled) {
              return (
                <span className="text-xs text-text-muted">
                  {row.sla.breached ? "Acknowledged late" : "Acknowledged"}
                </span>
              );
            }
            return (
              <StatusBadge tone={row.sla.breached ? "failed" : "approved"}>
                {row.sla.breached ? "Acknowledged late" : "Acknowledged"}
              </StatusBadge>
            );
          }
          if (row.sla.paused) return <StatusBadge tone="draft">Clock paused</StatusBadge>;
          if (row.sla.breached) return <StatusBadge tone="failed">Overdue</StatusBadge>;
          return (
            <span className="text-xs text-text-muted">
              Due <DateCell value={row.sla.dueAt} withTime />
            </span>
          );
        },
        exportValue: (row) =>
          row.acknowledgedAt
            ? row.sla.breached
              ? "acknowledged late"
              : "acknowledged"
            : row.sla.breached
              ? "overdue"
              : "within sla",
      },
      {
        key: "estimatedValue",
        header: "Est. value",
        align: "right",
        cell: (row) => <MoneyCell value={row.estimatedValue} currency={row.currency} />,
        exportValue: (row) => row.estimatedValue ?? "",
      },
      {
        key: "receivedAt",
        header: "Received",
        sortable: true,
        cell: (row) => <DateCell value={row.receivedAt} />,
        exportValue: (row) => row.receivedAt,
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <span className="flex justify-end gap-1">
            {/*
              Only offered on a settled inquiry, because the service refuses anything else and a
              button that exists to be rejected teaches people the app argues with them.
            */}
            {(archived || ARCHIVABLE.includes(row.status)) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={setArchived.isPending}
                onClick={(event) => {
                  event.stopPropagation();
                  setArchived.mutate({ inquiryId: row.id, archived: !archived });
                }}
              >
                {archived ? "Bring it back" : "Archive"}
              </Button>
            )}
            <Button asChild variant="ghost" size="sm">
              <Link href={`/crm/inquiries/${row.id}`} onClick={(e) => e.stopPropagation()}>
                Open
              </Link>
            </Button>
          </span>
        ),
        exportValue: () => "",
      },
    ],
    [archived, setArchived],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={archived ? "Archived inquiries" : "Inquiries"}
        description={
          archived
            ? "Settled and filed away. Nothing here is waiting on anybody — bring one back if it turns out otherwise."
            : "Every enquiry still in play, and where each one has got to. Settled ones move to the archive."
        }
        actions={
          archived ? (
            <Button asChild variant="secondary">
              <Link href="/crm/inquiries">Back to live inquiries</Link>
            </Button>
          ) : (
            <span className="flex flex-wrap gap-2">
              <Button asChild variant="secondary">
                <Link href="/crm/inquiries/archive">See archives</Link>
              </Button>
              <Button onClick={() => setDialogOpen(true)}>Log inquiry</Button>
            </span>
          )
        }
      />

      {setArchived.error && <p className="mt-2 text-sm text-danger">{setArchived.error.message}</p>}

      <DataTable<InquiryRow>
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as InquiryRow[]}
        total={list.data?.total ?? 0}
        rowId={(row) => row.id}
        state={state}
        onStateChange={setState}
        isLoading={list.isPending}
        exportFilename="aies-inquiries"
        onRowClick={(row) => router.push(`/crm/inquiries/${row.id}`)}
        emptyState={
          <EmptyState
            title={
              state.search
                ? "No inquiries match that search."
                : archived
                  ? "Nothing has been filed away yet."
                  : "No inquiries yet."
            }
            description={
              state.search
                ? "Number, subject and account name are all searched."
                : archived
                  ? "An inquiry can be archived once a PO is in, or once it is won, lost or disqualified."
                  : "Log the first one — it takes a subject and nothing else."
            }
            action={
              state.search || archived ? null : (
                <Button onClick={() => setDialogOpen(true)}>Log inquiry</Button>
              )
            }
          />
        }
      />

      <InquiryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(id) => router.push(`/crm/inquiries/${id}`)}
      />
    </div>
  );
}
