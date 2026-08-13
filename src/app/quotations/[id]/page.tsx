"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { humanQuotationStatus, isEditable } from "@/server/core/quotation/quotation-lifecycle";
import type { VatMode } from "@/server/core/quotation/costing";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";
import { ApprovalPanel } from "./ApprovalPanel";
import { IssuancePanel } from "./IssuancePanel";
import { LineEditor, type DraftLine } from "./LineEditor";
import { MarginPanel } from "./MarginPanel";
import { TermsPanel } from "./TermsPanel";
import { RevisionPanel } from "./RevisionPanel";
import { NegotiationPanel } from "./NegotiationPanel";
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
    revision: number;
    quoteType: string;
    validUntil: string;
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
    lines: {
      groupLabel: string | null;
      description: string;
      quantity: string;
      unit: string;
      unitCost?: string;
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
            <NegotiationPanel
              quotationId={data.id}
              status={data.status}
              currency={data.currency}
              canSeeCost={canSeeCost}
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

          <RfqPanel
            quotationId={data.id}
            editable={editable}
            canSeeCost={canSeeCost}
            lines={data.lines.map((line, index) => ({
              lineNo: index + 1,
              description: line.description,
            }))}
            onApplied={refresh}
          />

          <TermsPanel
            quotationId={data.id}
            version={data.version}
            editable={editable}
            deliveryLeadTime={data.deliveryLeadTime}
            incoterm={data.deliveryTermIncoterm}
            paymentTerms={data.paymentTermsText}
            warranty={data.warrantyTerms}
            termsAndConditions={data.termsAndConditions ?? []}
            onSaved={refresh}
          />

          <div onChangeCapture={() => setDirty(true)}>
            <LineEditor
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
        </div>
      </RecordLayout>
    </div>
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
