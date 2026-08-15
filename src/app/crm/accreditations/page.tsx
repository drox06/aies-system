"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { AccreditationPanel } from "./AccreditationPanel";

/**
 * specs/01-crm-inquiry.md §5b — the register PD works from.
 *
 * This is AIES's accreditation *with each customer*: whether that customer will issue us a PO.
 * It is not the ISO 9001 clause 8.4 approved-supplier list, which points the other way and belongs
 * to spec 08 §5.
 */

const TONE: Record<string, StatusTone> = {
  not_started: "draft",
  preparing: "info",
  submitted: "info",
  under_review: "pending",
  accredited: "approved",
  renewal_due: "pending",
  rejected: "failed",
  expired: "failed",
};

const LABEL: Record<string, string> = {
  not_started: "Not started",
  preparing: "Preparing",
  submitted: "Submitted",
  under_review: "Under review",
  accredited: "Accredited",
  renewal_due: "Renewal due",
  rejected: "Rejected",
  expired: "Expired",
};

export default function AccreditationsPage() {
  const list = trpc.crm.listAccreditations.useQuery();
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = list.data ?? [];
  // Worst first — an expired accreditation is someone's afternoon, not a row to scroll past.
  const ordered = [...rows].sort((a, b) => {
    const rank = (s: string) =>
      s === "expired" || s === "rejected"
        ? 0
        : s === "renewal_due"
          ? 1
          : s === "accredited"
            ? 3
            : 2;
    return rank(a.health.effectiveStatus) - rank(b.health.effectiveStatus);
  });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Customer accreditations"
        description="Whether each customer will issue AIES a purchase order. Industrial and utility buyers require accreditation first, and it lapses."
      />

      {list.isPending && <p className="text-sm text-text-muted">Loading...</p>}

      {/* Starting one lives here as well as on the account, because this is the screen PD works
          from and "which customers have we not started yet" is the question they open it with. It
          used to say "go to accounts" — where the card was read-only, so the trail ended. */}
      <StartAccreditationRow
        trackedAccountIds={rows.map((row) => row.accountId)}
        onStarted={() => void list.refetch()}
      />

      {!list.isPending && ordered.length === 0 && (
        <Card>
          <EmptyState
            title="No accreditations tracked yet."
            description="Start one for a customer above, or from the customer's own record. Then upload the certificate they issue and type its expiry date — that date is what drives the renewal reminders."
            action={
              <Button asChild variant="secondary">
                <Link href="/crm/accounts">Go to accounts</Link>
              </Button>
            }
          />
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {ordered.map((row) => {
          const isOpen = openId === row.id;
          return (
            <Card key={row.id} className="p-0">
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : row.id)}
                className="flex w-full flex-wrap items-center gap-3 p-4 text-left hover:bg-surface-2"
                aria-expanded={isOpen}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.account.name}</p>
                  <p className="tabular truncate text-xs text-text-muted">{row.account.code}</p>
                </div>

                <StatusBadge tone={TONE[row.health.effectiveStatus] ?? "draft"}>
                  {LABEL[row.health.effectiveStatus] ?? row.health.effectiveStatus}
                </StatusBadge>

                {row.health.blocksSelling && (
                  <span className="text-xs font-medium text-danger">Cannot issue us a PO</span>
                )}

                <div className="text-right text-xs text-text-muted">
                  {row.expiresAt ? (
                    <>
                      Expires <DateCell value={row.expiresAt} />
                    </>
                  ) : (
                    "No expiry recorded"
                  )}
                  {row.health.daysUntilExpiry !== null && (
                    <p>
                      {row.health.daysUntilExpiry < 0
                        ? "expired"
                        : `in ${row.health.daysUntilExpiry} day${row.health.daysUntilExpiry === 1 ? "" : "s"}`}
                    </p>
                  )}
                </div>

                <span aria-hidden className="text-text-muted">
                  {isOpen ? "▾" : "▸"}
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-border p-4">
                  <AccreditationPanel
                    accountId={row.accountId}
                    onChanged={() => void list.refetch()}
                  />
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Start tracking accreditation for…" — the way in that did not exist.
 *
 * Customers already tracked are filtered out rather than shown and refused: the model allows one
 * live accreditation per account, so offering a second is offering an error.
 */
function StartAccreditationRow({
  trackedAccountIds,
  onStarted,
}: {
  trackedAccountIds: string[];
  onStarted: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const accounts = trpc.crm.listAccounts.useQuery({ pageSize: 100 });
  const start = trpc.crm.startAccreditation.useMutation();

  const tracked = new Set(trackedAccountIds);
  const available = (accounts.data?.rows ?? []).filter((account) => !tracked.has(account.id));

  return (
    <Card className="mb-3 p-4">
      <h2 className="text-sm font-semibold">Start tracking a customer</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Then upload the certificate that customer issues to AIES, and type its expiry date. The
        expiry is what drives the renewal reminders — nothing reads it off the scan.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Label htmlFor="acc-account">Customer</Label>
          <Select id="acc-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose…</option>
            {available.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.code})
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={start.isPending || !accountId}
          onClick={async () => {
            try {
              await start.mutateAsync({ accountId });
              toastSuccess("Started. Open the row below to add the certificate and expiry date.");
              setAccountId("");
              onStarted();
            } catch (error) {
              toastError(error);
            }
          }}
        >
          {start.isPending ? "Starting…" : "Start accreditation"}
        </Button>
      </div>
      {available.length === 0 && (accounts.data?.rows ?? []).length > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          Every customer on file is already tracked here.
        </p>
      )}
    </Card>
  );
}
