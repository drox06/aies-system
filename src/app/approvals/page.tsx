"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/layout";
import { Label, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/00-foundation.md §7.4: "a global 'Awaiting my approval' inbox."
 *
 * ## What this screen used to show
 *
 *     CashAdvance — cmsyrix32002pl5045aucx6ca
 *     [Approve] [Reject]
 *
 * An entity type and a database id. No number, no amount, no purpose, no requester, no link to the
 * record, and no box for a reason when sending something back. The company put it plainly: the
 * approver should be able to inspect what he is going to approve.
 *
 * They are right, and it is worse than a usability complaint. An approval is the control — the
 * moment a second person is supposed to look. A screen that cannot show what is being decided turns
 * that control into a formality, and a formality in an ISO-audited process is a finding.
 *
 * ## Where the readable facts come from
 *
 * `entitySnapshot`, captured when the request was raised. It is deliberately the honest record of
 * *what the approver was shown* — a later edit to the underlying record cannot rewrite it, which is
 * exactly the property you want behind a decision somebody has to stand by. It was being stored and
 * never displayed.
 */

/** Snapshot keys in the order they should be read, with the company's words for them. */
const FIELD_LABELS: Record<string, string> = {
  number: "Document",
  amount: "Amount",
  currency: "Currency",
  total: "Total",
  purpose: "What it is for",
  ticket: "Ticket",
  account: "Customer",
  supplier: "Supplier",
  requestedBy: "Requested by",
  neededBy: "Needed by",
  revision: "Revision",
  reason: "Reason",
};

/** Where the record itself lives, when the id alone is enough to find it. */
function recordHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "Quotation":
      return `/quotations/${entityId}`;
    case "SupplierPO":
      return `/procurement/${entityId}`;
    case "InquiryQuotingWaiver":
      return `/crm/inquiries/${entityId}`;
    default:
      // Cash advances live on their ticket rather than at a page of their own, and the request
      // carries the ticket *number* rather than its id. Showing the number and no link is honest;
      // a link built from the wrong id would be worse than none.
      return null;
  }
}

const TYPE_LABELS: Record<string, string> = {
  CashAdvance: "Cash advance",
  CashAdvanceExtension: "Liquidation extension",
  InquiryQuotingWaiver: "Requirements waiver",
  Quotation: "Quotation",
  SupplierPO: "Supplier PO",
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "amount" || key === "total") {
    const amount = typeof value === "number" ? value : Number(value);
    return Number.isFinite(amount)
      ? `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`
      : String(value);
  }
  if (key === "neededBy" && typeof value === "string") return value.slice(0, 10);
  return String(value);
}

export default function ApprovalsInboxPage() {
  const utils = trpc.useUtils();
  const inbox = trpc.approvals.myInbox.useQuery();
  const decide = trpc.approvals.decide.useMutation({
    onSuccess: () => {
      setRejecting(null);
      setReason("");
      void utils.approvals.myInbox.invalidate();
    },
  });

  const [error, setError] = useState<string | null>(null);
  /** Which request is being sent back. A rejection without a reason is not a decision. */
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function handleDecide(
    requestId: string,
    decision: "approved" | "rejected",
    comment?: string,
  ) {
    setError(null);
    try {
      await decide.mutateAsync({ requestId, decision, comment });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record decision.");
    }
  }

  return (
    <div>
      <PageHeader
        title="Awaiting my approval"
        description="What is waiting on you, with the figures as they stood when it was sent. Open the record if you want more than this."
      />

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {inbox.isPending && <p className="mt-3 text-sm text-text-muted">Loading…</p>}

      {inbox.data?.length === 0 && (
        <Card className="mt-4 p-4">
          <p className="text-sm">Nothing is waiting on you.</p>
        </Card>
      )}

      <div className="mt-4 space-y-3">
        {inbox.data?.map((request) => {
          const snapshot = (request.entitySnapshot ?? {}) as Record<string, unknown>;
          const href = recordHref(request.entityType, request.entityId);
          const fields = Object.keys(FIELD_LABELS).filter((key) => key in snapshot);

          return (
            <Card key={request.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  {TYPE_LABELS[request.entityType] ?? request.entityType}
                  {typeof snapshot.number === "string" && (
                    <span className="ml-2 tabular font-normal">{snapshot.number}</span>
                  )}
                </h2>
                <StatusBadge tone="pending">Waiting on you</StatusBadge>
              </div>

              {fields.length > 0 ? (
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  {fields
                    .filter((key) => key !== "number")
                    .map((key) => (
                      <div key={key} className="flex justify-between gap-3 sm:block">
                        <dt className="text-text-muted">{FIELD_LABELS[key]}</dt>
                        <dd className={key === "amount" || key === "total" ? "tabular" : ""}>
                          {formatValue(key, snapshot[key])}
                        </dd>
                      </div>
                    ))}
                </dl>
              ) : (
                <p className="mt-2 text-sm text-text-muted">
                  This request was raised without a summary. Open the record before deciding.
                </p>
              )}

              <p className="mt-3 text-xs text-text-muted">
                Sent {new Date(request.requestedAt).toLocaleString()}
              </p>

              {href && (
                <p className="mt-2">
                  <Link href={href} className="text-sm underline">
                    Open the record
                  </Link>
                </p>
              )}

              {rejecting === request.id ? (
                <div className="mt-3 rounded-md border-2 border-amber-400 bg-amber-50 p-3">
                  <Label htmlFor={`reason-${request.id}`}>Why are you sending this back?</Label>
                  <Textarea
                    id={`reason-${request.id}`}
                    rows={2}
                    className="mt-1"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <p className="mt-1 text-xs text-amber-900">
                    The person who raised it sees this and nothing else. Without it they can only
                    guess at what to change.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={decide.isPending || reason.trim().length === 0}
                      onClick={() => void handleDecide(request.id, "rejected", reason)}
                    >
                      {decide.isPending ? "Sending back…" : "Send it back"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRejecting(null);
                        setReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  {reason.trim().length === 0 && (
                    <p className="mt-1 text-xs text-amber-900">Write the reason first.</p>
                  )}
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => void handleDecide(request.id, "approved")}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() => setRejecting(request.id)}
                  >
                    Send it back
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
