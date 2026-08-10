"use client";

import { use } from "react";
import Link from "next/link";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { DateCell, MoneyCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import { trpc } from "@/lib/trpc/client";
import { InquiryStatusActions } from "./InquiryStatusActions";
import { InspectionPanel } from "./InspectionPanel";
import { RequirementsPanel } from "./RequirementsPanel";

export default function InquiryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const inquiry = trpc.crm.getInquiry.useQuery({ inquiryId: id });

  if (inquiry.isPending) {
    return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  }
  if (inquiry.error) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-6">
          <p className="font-medium">This inquiry is not available.</p>
          <p className="mt-1 text-sm text-text-muted">{inquiry.error.message}</p>
          <Button asChild variant="ghost" size="sm" className="mt-3">
            <Link href="/crm/inquiries">Back to inquiries</Link>
          </Button>
        </Card>
      </div>
    );
  }

  const data = inquiry.data;
  const sla = data.sla;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`${data.number} — ${data.subject}`}
        description={
          data.account
            ? `${data.account.name} · ${data.account.code}`
            : "Not linked to an account yet."
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone={data.status === "lost" ? "failed" : "active"}>
              <span className="capitalize">{humanStatus(data.status)}</span>
            </StatusBadge>
            <InquiryStatusActions inquiry={data} />
          </div>
        }
      />

      <RecordLayout aside={<ActivityFeed entityType="Inquiry" entityId={data.id} />}>
        <div className="space-y-4">
          {/* §3's SLA, stated plainly. The one number that decides whether this record is a
              problem should not require reading a table to find. */}
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Acknowledgement</h2>
            {data.acknowledgedAt ? (
              <p className="mt-1 text-sm text-text-muted">
                Acknowledged <DateCell value={data.acknowledgedAt} withTime />
                {sla.breached && (
                  <span className="ml-2">
                    <StatusBadge tone="failed">Past its SLA</StatusBadge>
                  </span>
                )}
              </p>
            ) : sla.paused ? (
              <p className="mt-1 text-sm text-text-muted">
                Clock paused while the site inspection is open. Due{" "}
                <DateCell value={sla.dueAt} withTime /> once it resumes.
              </p>
            ) : (
              <p className="mt-1 text-sm text-text-muted">
                Due <DateCell value={sla.dueAt} withTime />.{" "}
                {sla.breached ? (
                  <StatusBadge tone="failed">Overdue — escalates to KJ and EA</StatusBadge>
                ) : (
                  "Not yet acknowledged."
                )}
              </p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Details</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Field label="Received">
                <DateCell value={data.receivedAt} />
              </Field>
              <Field label="Source">
                <span className="capitalize">{humanStatus(data.source)}</span>
              </Field>
              <Field label="Required by">
                <DateCell value={data.requiredByDate} />
              </Field>
              <Field label="Estimated value">
                <MoneyCell value={data.estimatedValue} currency={data.currency} />
              </Field>
              <Field label="Assigned to">{data.owner?.name ?? "—"}</Field>
              <Field label="Industry">{data.industry ?? "—"}</Field>
              <Field label="Site">{data.site?.name ?? "—"}</Field>
            </dl>
            {data.description && (
              <p className="mt-3 border-t border-border pt-3 text-sm whitespace-pre-wrap">
                {data.description}
              </p>
            )}
            {data.site?.accessNotes && (
              <p className="mt-3 rounded border border-border bg-surface-2 p-2 text-xs">
                <span className="font-medium">Site access:</span> {data.site.accessNotes}
              </p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">What they asked for</h2>
            {data.items.length === 0 ? (
              <p className="mt-1 text-sm text-text-muted">No line items yet.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Description</th>
                    <th className="py-1 text-right font-medium">Qty</th>
                    <th className="py-1 font-medium">Service</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-border last:border-0">
                      <td className="py-1.5 tabular text-text-muted">{item.lineNo}</td>
                      <td className="py-1.5">
                        {item.description}
                        {item.manufacturer && (
                          <span className="block text-xs text-text-muted">
                            {item.manufacturer} {item.modelNumber}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="py-1.5 text-xs">{item.serviceType ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <RequirementsPanel inquiry={data} />
          <InspectionPanel inquiry={data} />
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
