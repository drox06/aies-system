"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";
import { CustomerPoDialog } from "@/app/crm/pipeline/CustomerPoDialog";

/**
 * The customer's purchase order on the inquiry record (specs/03-order-procurement.md §2).
 *
 * The board is where this normally happens — drag out of "Sent", fill the form — but the board is
 * not the only way anybody works, and a PO recorded there has to be visible and downloadable from
 * the record afterwards. Spec.md §6.6's rule about drag being an enhancement applies to the whole
 * interaction, not just to the drop.
 *
 * The dialog is shared with the board rather than duplicated: one form, one set of validation
 * messages, and no chance of the two drifting on what "mandatory" means.
 */
export function CustomerPoPanel({
  inquiryId,
  inquiryNumber,
  subject,
  status,
  liveQuotation,
  onRecorded,
}: {
  inquiryId: string;
  inquiryNumber: string;
  subject: string;
  status: string;
  liveQuotation: { id: string; number: string; total: string; currency: string } | null;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  // Gated on `customer_po.view`. A technician assigned a site inspection can open this inquiry
  // (inquiryScopeWhere lets them) and has no business seeing the customer's commercial paperwork —
  // so a refusal here removes the panel rather than showing an error, or worse, a button that
  // 403s when pressed.
  const pos = trpc.order.forInquiry.useQuery({ inquiryId }, { retry: false });
  if (pos.error) return null;

  const rows = pos.data ?? [];
  const canRecord = status === "quoted";
  if (!canRecord && rows.length === 0) return null;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Customer PO</h2>

      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">
          Nothing recorded yet. This inquiry stays in <strong>Sent</strong> until the
          customer&rsquo;s purchase order is here, with a scan of it.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((po) => (
            <li key={po.id} className="text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{po.poNumber}</span>
                <span className="tabular">{formatMoney(po.amount, po.currency)}</span>
              </div>
              <p className="text-xs text-text-muted">
                Dated <DateCell value={po.poDate} /> · recorded{" "}
                <DateCell value={po.receivedAt} withTime />
              </p>
              <Button asChild size="sm" variant="ghost" className="mt-1 px-0">
                {/* The scan itself. Access is decided by the checker the order service registers,
                    so the same people who can see the row can open the document. */}
                <a href={`/api/files/${po.fileId}`} target="_blank" rel="noreferrer">
                  Open the scanned PO
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canRecord && (
        <Button size="sm" className="mt-3" onClick={() => setOpen(true)}>
          Record customer PO
        </Button>
      )}

      <CustomerPoDialog
        open={open}
        onOpenChange={setOpen}
        inquiry={{ id: inquiryId, number: inquiryNumber, subject, liveQuotation }}
        onRecorded={() => {
          void utils.order.forInquiry.invalidate({ inquiryId });
          onRecorded();
        }}
      />
    </Card>
  );
}
