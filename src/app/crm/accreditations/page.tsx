"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
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

      {!list.isPending && ordered.length === 0 && (
        <Card>
          <EmptyState
            title="No accreditations tracked yet."
            description="Open a customer account and start its accreditation to track the document checklist, expiry dates and renewals."
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
          const soonest = row.health.expiringDocuments[0];
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
                  {soonest && (
                    <p>
                      {soonest.document}{" "}
                      {soonest.daysRemaining < 0
                        ? "expired"
                        : `in ${soonest.daysRemaining} day${soonest.daysRemaining === 1 ? "" : "s"}`}
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
