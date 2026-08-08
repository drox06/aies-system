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
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";
import { CreateAccountDialog } from "./CreateAccountDialog";

type AccountRow = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  status: string;
  industry: string | null;
  createdAt: Date;
  _count: { sites: number; contacts: number };
};

/** specs/01-crm-inquiry.md §2's three statuses. `blacklisted` is `failed` rather than `cancelled`:
 *  it is a decision someone made about this customer, not a dormant record. */
const STATUS_TONE: Record<string, StatusTone> = {
  active: "active",
  dormant: "draft",
  blacklisted: "failed",
};

export default function AccountsPage() {
  const [state, setState] = useState<DataTableState>(DEFAULT_TABLE_STATE);
  const [createOpen, setCreateOpen] = useState(false);

  const list = trpc.crm.listAccounts.useQuery({
    search: state.search || undefined,
    page: state.page,
    pageSize: state.pageSize,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });

  const columns = useMemo<Column<AccountRow>[]>(
    () => [
      {
        key: "code",
        header: "Code",
        sortable: true,
        width: "9rem",
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
        key: "accountType",
        header: "Type",
        sortable: true,
        cell: (row) => <span className="capitalize">{row.accountType}</span>,
        exportValue: (row) => row.accountType,
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
        key: "sites",
        header: "Sites",
        align: "right",
        cell: (row) => <span className="tabular">{row._count.sites}</span>,
        exportValue: (row) => row._count.sites,
      },
      {
        key: "contacts",
        header: "Contacts",
        align: "right",
        cell: (row) => <span className="tabular">{row._count.contacts}</span>,
        exportValue: (row) => row._count.contacts,
      },
      {
        key: "createdAt",
        header: "Added",
        sortable: true,
        defaultHidden: true,
        cell: (row) => <DateCell value={row.createdAt} />,
        exportValue: (row) => row.createdAt.toISOString().slice(0, 10),
      },
    ],
    [],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Accounts"
        description="Customers and prospects. Each account owns its sites, contacts and inquiries."
        actions={<Button onClick={() => setCreateOpen(true)}>New account</Button>}
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
        emptyState={
          <EmptyState
            title={state.search ? "No accounts match that search." : "No accounts yet."}
            description={
              state.search
                ? "Try a shorter search — code, name, legal name and TIN are all searched."
                : "Add the first customer or prospect to start logging inquiries against it."
            }
            action={
              state.search ? null : <Button onClick={() => setCreateOpen(true)}>New account</Button>
            }
          />
        }
      />

      <CreateAccountDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void list.refetch()}
      />
    </div>
  );
}
