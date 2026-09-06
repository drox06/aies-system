"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { Label, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { humanQuotationStatus, isEditable } from "@/server/core/quotation/quotation-lifecycle";
import type { VatMode } from "@/server/core/quotation/costing";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";
import { ApprovalPanel } from "./ApprovalPanel";
import { CustomerReplyPanel } from "./CustomerReplyPanel";
import { IssuancePanel } from "./IssuancePanel";
import { LineEditor, type DraftLine } from "./LineEditor";
import { MarginPanel } from "./MarginPanel";
import { TermsPanel } from "./TermsPanel";
import { RevisionPanel } from "./RevisionPanel";
import { ScopeChangeBanner } from "./ScopeChangeBanner";
import { ReusePanel } from "./ReusePanel";
import { RfqPanel } from "./RfqPanel";

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

export default function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = trpc.useUtils();
  const quotation = trpc.quotation.get.useQuery({ quotationId: id });
  const [dirty, setDirty] = useState(false);

  if (quotation.isPending) return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  if (quotation.error) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-6">
          <p className="font-medium">This quotation is not available.</p>
          <p className="mt-1 text-sm text-text-muted">{quotation.error.message}</p>
          <Button asChild variant="ghost" size="sm" className="mt-3">
            <Link href="/quotations">Back to quotations</Link>
          </Button>
        </Card>
      </div>
    );
  }

  // The payload is deliberately loose about cost: those fields are absent for a caller without
  // `finance.view_cost`, so everything below reads them defensively rather than assuming a number.
  const data = quotation.data as unknown as {
    id: string;
    displayNumber: string;
    title: string;
    status: string;
    version: number;
    currency: string;
    fxRate: string;
    revision: number;
    quoteType: string;
    // superjson revives this as a real Date on the client, not the string this cast used to claim.
    validUntil: Date | string;
    scopeOfWork: string;
    total: string;
    subtotal: string;
    discountAmount: string;
    vatMode: string;
    fxBufferPct: string;
    totalCost?: string;
    marginAmount?: string;
    marginPct?: string;
    deliveryLeadTime: string | null;
    deliveryTermIncoterm: string | null;
    paymentTermsId: string | null;
    paymentTermsText: string | null;
    warrantyTerms: string | null;
    termsAndConditions: string[];
    rejectionReason: string | null;
    downloadedAt: string | null;
    downloadedBy: string | null;
    downloadCount: number;
    sentAt: string | null;
    account: { id: string; code: string; name: string } | null;
    inquiry: { id: string; number: string } | null;
    // module 04 §6.1's mark, carried on the document it affects. See ScopeChangeBanner.
    scopeChangeFlaggedAt: string | null;
    scopeChangeNotes: string | null;
    scopeChangeSource: string | null;
    scopeChangeInspectionId: string | null;
    scopeChangeResolvedAt: string | null;
    scopeChangeResolution: string | null;
    scopeChangeResolutionNote: string | null;
    lines: {
      // Sent all along; declared now because §3's PO check compares by line number, and a check
      // that matched on array position would misread any quotation whose lines were reordered.
      lineNo: number;
      groupLabel: string | null;
      description: string;
      quantity: string;
      unit: string;
      unitCost?: string;
      costCurrency?: string;
      costFxRate?: string;
      fxBufferPct?: string | null;
      freightCostPct?: string | null;
      dutiesTaxesPct?: string | null;
      localDeliveryCost?: string | null;
      markupPct?: string | null;
      unitPrice: string;
      lineDiscountPct: string | null;
      isOptional: boolean;
    }[];
  };

  const canSeeCost = data.totalCost !== undefined;
  const editable = isEditable(data.status);

  const initialLines: DraftLine[] = data.lines.map((line) => ({
    groupLabel: line.groupLabel ?? "",
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitCost: line.unitCost ?? "",
    costCurrency: line.costCurrency ?? "PHP",
    fxBufferPct: line.fxBufferPct ?? "",
    costFxRate: line.costFxRate ?? "1",
    freightCostPct: line.freightCostPct ?? "",
    dutiesTaxesPct: line.dutiesTaxesPct ?? "",
    localDeliveryCost: line.localDeliveryCost ?? "",
    markupPct: line.markupPct ?? "",
    unitPrice: line.unitPrice,
    lineDiscountPct: line.lineDiscountPct ?? "",
    isOptional: line.isOptional,
  }));

  const refresh = () => {
    setDirty(false);
    void utils.quotation.get.invalidate({ quotationId: id });
    void utils.quotation.revisions.invalidate({ quotationId: id });
    void utils.quotation.list.invalidate();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`${data.displayNumber} — ${data.title}`}
        description={
          data.account ? `${data.account.name} · ${data.account.code}` : "No account linked."
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{humanQuotationStatus(data.status)}</span>
            </StatusBadge>
            <span className="tabular text-sm font-semibold">
              {formatMoney(data.total, data.currency)}
            </span>
            <DeleteQuotation
              quotationId={data.id}
              displayNumber={data.displayNumber}
              onDeleted={() => router.push("/quotations")}
            />
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <ApprovalPanel
              quotationId={data.id}
              status={data.status}
              rejectionReason={data.rejectionReason}
              onChanged={refresh}
            />
            <IssuancePanel
              quotationId={data.id}
              status={data.status}
              canSeeCost={canSeeCost}
              downloadedAt={data.downloadedAt}
              downloadedByName={data.downloadedBy}
              downloadCount={data.downloadCount}
              sentAt={data.sentAt}
              onChanged={refresh}
            />
            <MarginPanel
              currency={data.currency}
              totalCost={data.totalCost}
              marginAmount={data.marginAmount}
              marginPct={data.marginPct}
              stale={dirty}
            />
            <CustomerReplyPanel
              quotationId={data.id}
              quotationNumber={data.displayNumber}
              status={data.status}
              currency={data.currency}
              canSeeCost={canSeeCost}
              // Optional lines are excluded here for the same reason the server excludes them: §7
              // keeps them off the total, so they are not part of what was agreed and must not be
              // reported as "quoted but not ordered".
              quotationLines={data.lines
                .filter((line) => !line.isOptional)
                .map((line) => ({
                  lineNo: line.lineNo,
                  description: line.description,
                  quantity: line.quantity,
                }))}
              onChanged={refresh}
            />
            <RevisionPanel
              quotationId={data.id}
              status={data.status}
              revision={data.revision}
              currency={data.currency}
              onRevised={refresh}
            />
            <ReusePanel
              quotationId={data.id}
              currency={data.currency}
              canSeeCost={canSeeCost}
              editable={editable}
            />
            <ActivityFeed entityType="Quotation" entityId={data.id} />
          </div>
        }
      >
        <div className="space-y-4">
          {/* Above Details on purpose: it is the one thing on this page that changes what the
              reader should do next. */}
          <ScopeChangeBanner
            quotationId={data.id}
            flaggedAt={data.scopeChangeFlaggedAt}
            notes={data.scopeChangeNotes}
            source={data.scopeChangeSource}
            inspectionId={data.scopeChangeInspectionId}
            resolvedAt={data.scopeChangeResolvedAt}
            resolution={data.scopeChangeResolution}
            resolutionNote={data.scopeChangeResolutionNote}
            onResolved={() => void quotation.refetch()}
          />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Details</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Field label="Series">{data.quoteType === "indent" ? "Indent" : "Local"}</Field>
              <Field label="Valid until">
                <DateCell value={data.validUntil} />
              </Field>
              <Field label="From inquiry">
                {data.inquiry ? (
                  <Link href={`/crm/inquiries/${data.inquiry.id}`} className="hover:underline">
                    {data.inquiry.number}
                  </Link>
                ) : (
                  "—"
                )}
              </Field>
            </dl>
            {data.scopeOfWork && (
              <p className="mt-3 border-t border-border pt-3 text-sm whitespace-pre-wrap">
                {data.scopeOfWork}
              </p>
            )}
          </Card>

          {/* Above Lines on the company's instruction (2026-09-04): a line often waits on a
              supplier's price before it can be filled in at all, so the request that produces that
              price reads before the table that consumes it. */}
          <RfqPanel
            quotationId={data.id}
            version={data.version}
            quotationCurrency={data.currency}
            quotationFxRate={data.fxRate}
            editable={editable}
            canSeeCost={canSeeCost}
            lines={data.lines.map((line, index) => ({
              lineNo: index + 1,
              description: line.description,
            }))}
            onApplied={refresh}
          />

          <div onChangeCapture={() => setDirty(true)}>
            <LineEditor
              /**
               * Remounted whenever the stored version moves, which is what makes a cost applied
               * from somewhere else actually appear here.
               *
               * `LineEditor` seeds its rows from `initialLines` with `useState`, so React uses that
               * value **once** and ignores every later one. That is correct for a form — it is why
               * typing survives a background refetch — and it was silently wrong for anything that
               * changes the lines from outside the editor. Recording a supplier response wrote the
               * cost to the database, the page refetched it, and this component went on rendering
               * the zero it had been born with until somebody reloaded the browser. The company
               * reported it as the supplier's price "not reflected on the lines".
               *
               * `version` is the right key because `saveQuotationLinesService` bumps it on every
               * write, so it moves exactly when the stored lines do and never otherwise. Unsaved
               * typing is not at risk from a *background* refetch, which leaves the version alone;
               * it is discarded only when the lines genuinely changed underneath, and in that case
               * optimistic locking would have refused the save anyway.
               */
              key={`lines-v${data.version}`}
              quotationId={data.id}
              version={data.version}
              currency={data.currency}
              canSeeCost={canSeeCost}
              editable={editable}
              initialLines={initialLines}
              initialDiscount={data.discountAmount}
              initialVatMode={data.vatMode as VatMode}
              initialFxBuffer={data.fxBufferPct}
              onSaved={refresh}
            />
          </div>

          <TermsPanel
            quotationId={data.id}
            version={data.version}
            editable={editable}
            paymentTermsId={data.paymentTermsId}
            paymentTermsText={data.paymentTermsText}
            deliveryTermIncoterm={data.deliveryTermIncoterm}
            deliveryLeadTime={data.deliveryLeadTime}
            validUntil={data.validUntil}
            warrantyTerms={data.warrantyTerms}
            termsAndConditions={data.termsAndConditions ?? []}
            onSaved={refresh}
          />
        </div>
      </RecordLayout>
    </div>
  );
}

/**
 * Deleting a quotation, for the two officers who hold `quotation.delete`.
 *
 * The button is hidden for everybody else by asking the server rather than by guessing from a role
 * in the browser — `quotation.delete` is a permission, and permissions are grantable.
 *
 * A reason is required and typed, not picked. The question asked six months later is never whether
 * something was deleted but why, and a picklist of three options would answer it badly.
 */
function DeleteQuotation({
  quotationId,
  displayNumber,
  onDeleted,
}: {
  quotationId: string;
  displayNumber: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  // `whoami` already carries the resolved permission set — asking the server rather than inferring
  // from a role name, because permissions are grantable and roles are not the rule.
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const remove = trpc.quotation.delete.useMutation();

  if (!me.data?.permissions.includes("quotation.delete")) return null;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Delete
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/40 p-4">
          <div className="w-full max-w-sm rounded-md border border-border bg-surface p-4 shadow-xl">
            <h2 className="text-sm font-semibold">Delete {displayNumber}?</h2>
            <p className="mt-1 text-xs text-text-muted">
              {/* Said plainly, because "delete" usually means something more final than this. */}
              It comes off the screens and out of search. The record, its lines and its audit trail
              stay, and the number is never handed out again.
            </p>
            <div className="mt-3">
              <Label htmlFor="del-reason">Why?</Label>
              <Textarea
                id="del-reason"
                rows={2}
                className="text-xs"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Raised against the wrong customer."
              />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={remove.isPending || reason.trim().length < 3}
                onClick={async () => {
                  try {
                    await remove.mutateAsync({ quotationId, reason });
                    toastSuccess(`${displayNumber} deleted.`);
                    setOpen(false);
                    onDeleted();
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                Delete it
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
