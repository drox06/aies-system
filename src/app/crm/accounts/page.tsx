"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  DEFAULT_TABLE_STATE,
  type Column,
  type DataTableState,
} from "@/components/ui/data-table";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";
import { AccountDialog } from "./AccountDialog";

interface AccountFlag {
  kind: string;
  severity: "blocking" | "warning" | "info" | "ok";
  label: string;
  detail?: string;
}

type AccountRow = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  status: string;
  industry: string | null;
  primaryContact: { id: string; name: string; mobile: string | null; email: string | null } | null;
  flags: AccountFlag[];
  _count: { sites: number; contacts: number };
};

/** specs/01-crm-inquiry.md §2's three statuses. `blacklisted` is `failed` rather than `cancelled`:
 *  it is a decision someone made about this customer, not a dormant record. */
const STATUS_TONE: Record<string, StatusTone> = {
  active: "active",
  dormant: "draft",
  blacklisted: "failed",
};

/** Severity → the §6.4 badge scale. `blocking` is danger because it stops a sale; `warning` is the
 *  orange "needs your attention" accent Spec.md §6.3 reserves for exactly this; `ok` is green,
 *  because a salesperson scanning this column is asking "can I quote them?" and green is the
 *  answer they are looking for. */
const FLAG_TONE: Record<AccountFlag["severity"], StatusTone> = {
  blocking: "failed",
  warning: "pending",
  info: "draft",
  ok: "approved",
};

export default function AccountsPage() {
  const [state, setState] = useState<DataTableState>(DEFAULT_TABLE_STATE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const list = trpc.crm.listAccounts.useQuery({
    search: state.search || undefined,
    page: state.page,
    pageSize: state.pageSize,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });

  const openCreate = () => {
    setEditingId(null);
    setDialogOpen(true);
  };
  const openEdit = (id: string) => {
    setEditingId(id);
    setDialogOpen(true);
  };

  const columns = useMemo<Column<AccountRow>[]>(
    () => [
      {
        key: "code",
        header: "Code",
        sortable: true,
        width: "8rem",
        cell: (row) => <span className="tabular font-medium">{row.code}</span>,
        exportValue: (row) => row.code,
      },
      {
        key: "name",
        header: "Account",
        sortable: true,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.name}</p>
            {row.industry && <p className="truncate text-xs text-text-muted">{row.industry}</p>}
          </div>
        ),
        exportValue: (row) => row.name,
      },
      {
        key: "contact",
        header: "Primary contact",
        cell: (row) =>
          row.primaryContact ? (
            <div className="min-w-0">
              <p className="truncate">{row.primaryContact.name}</p>
              <p className="truncate text-xs text-text-muted">
                {/* Mobile first: it is what a salesperson actually uses. */}
                {row.primaryContact.mobile ?? row.primaryContact.email ?? "—"}
              </p>
            </div>
          ) : (
            <span className="text-xs text-text-muted">None</span>
          ),
        exportValue: (row) =>
          row.primaryContact
            ? `${row.primaryContact.name} ${row.primaryContact.mobile ?? row.primaryContact.email ?? ""}`.trim()
            : "",
      },
      {
        // Filtered to accreditation only. The health aggregator is deliberately generic — module
        // 05 will register a finance contributor for unbilled work and overdue collections — but a
        // column headed "Accreditation Status" must not quietly start showing receivables. Finance
        // gets its own column when it lands; the aggregator does not change.
        key: "accreditation",
        header: "Accreditation Status",
        cell: (row) => {
          const flags = row.flags.filter((f) => f.kind === "accreditation");
          if (flags.length === 0) return <span className="text-xs text-text-muted">—</span>;
          return (
            <div className="flex flex-col items-start gap-1">
              {flags.map((flag) => (
                <StatusBadge
                  key={`${flag.kind}-${flag.label}`}
                  tone={FLAG_TONE[flag.severity]}
                  title={flag.detail}
                >
                  {flag.label}
                </StatusBadge>
              ))}
            </div>
          );
        },
        exportValue: (row) =>
          row.flags
            .filter((f) => f.kind === "accreditation")
            .map((f) => f.label)
            .join("; "),
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        cell: (row) => (
          <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
            <span className="capitalize">{row.status}</span>
          </StatusBadge>
        ),
        exportValue: (row) => row.status,
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              openEdit(row.id);
            }}
          >
            Edit
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
        title="Accounts"
        description="Customers and prospects. Each account owns its sites, contacts and inquiries."
        actions={<Button onClick={openCreate}>New account</Button>}
      />

      <DataTable<AccountRow>
        columns={columns}
        rows={(list.data?.rows ?? []) as AccountRow[]}
        total={list.data?.total ?? 0}
        rowId={(row) => row.id}
        state={state}
        onStateChange={setState}
        isLoading={list.isPending}
        exportFilename="aies-accounts"
        onRowClick={(row) => openEdit(row.id)}
        emptyState={
          <EmptyState
            title={state.search ? "No accounts match that search." : "No accounts yet."}
            description={
              state.search
                ? "Try a shorter search — code, name, legal name and TIN are all searched."
                : "Add the first customer or prospect to start logging inquiries against it."
            }
            action={state.search ? null : <Button onClick={openCreate}>New account</Button>}
          />
        }
      />

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        accountId={editingId}
        onSaved={() => void list.refetch()}
      />
    </div>
  );
}
