"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SUPPLIER_APPROVE_PERMISSION,
  SUPPLIER_ENTITY_TYPE,
  supplierApprovalState,
} from "@/server/core/order/supplier-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * One supplier: what is known about them, and whether they are approved to buy from.
 *
 * The clause 8.4 block is the reason this panel exists rather than the table linking straight to an
 * edit form. §2 puts the approval behind its own permission, and the audit trail underneath is what
 * turns "approved" from a checkbox into evidence — an auditor's question is never "is this supplier
 * approved", it is "who approved it, when, and on what basis".
 */
export function SupplierPanel({
  supplierId,
  onClose,
  onEdit,
  onChanged,
}: {
  supplierId: string;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const supplier = trpc.order.getSupplier.useQuery({ supplierId });
  const whoami = trpc.system.whoami.useQuery();
  const permissions = whoami.data?.permissions ?? [];
  const mayApprove = permissions.includes(SUPPLIER_APPROVE_PERMISSION);
  /** The President alone — see the order manifest. */
  const mayDelete = permissions.includes("supplier.delete");

  const [reason, setReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expiry, setExpiry] = useState("");

  const remove = trpc.order.deleteSupplier.useMutation();
  const setApproval = trpc.order.setSupplierApproval.useMutation({
    onSuccess: () => {
      void utils.order.getSupplier.invalidate({ supplierId });
      void utils.order.listSuppliers.invalidate();
      setReason("");
      onChanged();
    },
  });

  const data = supplier.data;
  const state = data ? supplierApprovalState(data) : "none";

  async function decide(isApproved: boolean) {
    try {
      await setApproval.mutateAsync({
        supplierId,
        isApproved,
        approvalExpiry: isApproved && expiry ? new Date(expiry) : null,
        reason,
      });
      toastSuccess(isApproved ? "Approved." : "Approval withdrawn.");
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[92dvh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          {!data ? (
            <>
              <Dialog.Title className="text-base font-semibold">Loading…</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                Fetching the supplier.
              </Dialog.Description>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Dialog.Title className="text-base font-semibold">{data.name}</Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-text-muted">
                    <span className="tabular">{data.code}</span>
                    {data.country ? ` · ${data.country}` : ""} · quotes in {data.currency}
                  </Dialog.Description>
                </div>
                <Button variant="secondary" size="sm" onClick={onEdit}>
                  Edit
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {data.isPrincipal && <StatusBadge tone="info">Principal</StatusBadge>}
                {state === "approved" && <StatusBadge tone="approved">Approved</StatusBadge>}
                {state === "expired" && <StatusBadge tone="failed">Approval expired</StatusBadge>}
                {state === "none" && <StatusBadge tone="draft">Not approved</StatusBadge>}
                {data.principalProspect && (
                  <Link
                    href="/crm/principals"
                    className="text-xs text-blue-600 underline underline-offset-2"
                  >
                    From the principal pipeline
                  </Link>
                )}
              </div>

              <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <Detail label="Contact">
                  {[data.contactName, data.email, data.phone].filter(Boolean).join(" · ") || "—"}
                </Detail>
                <Detail label="Product lines">{data.productLines.join(", ") || "—"}</Detail>
                <Detail label="Payment terms">{data.paymentTerms ?? "—"}</Detail>
                <Detail label="Incoterm">{data.incoterm ?? "—"}</Detail>
                <Detail label="Typical lead time">
                  {data.leadTimeDaysTypical ? `${data.leadTimeDaysTypical} days` : "—"}
                </Detail>
                <Detail label="Rating">{data.rating ? `${data.rating} / 5` : "—"}</Detail>
                {data.approvedAt && (
                  <Detail label="Approved on">
                    <DateCell value={data.approvedAt} />
                  </Detail>
                )}
                {data.approvalExpiry && (
                  <Detail label="Approval expires">
                    <DateCell value={data.approvalExpiry} />
                  </Detail>
                )}
              </dl>

              {data.notes && (
                <p className="mt-3 rounded-md border border-border bg-surface-muted p-2.5 text-sm whitespace-pre-wrap">
                  {data.notes}
                </p>
              )}

              <section className="mt-5 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">Approved supplier — ISO 9001 clause 8.4</h3>
                <p className="mt-1 text-xs text-text-muted">
                  Approval is about buying, not about quoting. Recording what an unapproved supplier
                  charges is fine; placing an order with one is the decision this controls.
                </p>

                {!mayApprove ? (
                  // Shown rather than hidden, unlike the principal appointment: everybody who can
                  // reach this panel needs to know the state, and knowing who to ask is more useful
                  // than an empty space where a control might be.
                  <p className="mt-2 text-xs text-text-muted">
                    Only the President and the Vice President record this decision.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    <div>
                      <Label htmlFor="sup-reason">Why</Label>
                      <Textarea
                        id="sup-reason"
                        rows={2}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Audited 12 Mar, ISO 9001 certificate on file, two years of on-time delivery."
                      />
                    </div>
                    {state !== "approved" && (
                      <div className="max-w-xs">
                        <Label htmlFor="sup-expiry">Review by (optional)</Label>
                        <Input
                          id="sup-expiry"
                          type="date"
                          value={expiry}
                          onChange={(e) => setExpiry(e.target.value)}
                        />
                        <p className="mt-0.5 text-xs text-text-muted">
                          An approval with no end date is one nobody revisits.
                        </p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {state !== "approved" && (
                        <Button
                          onClick={() => void decide(true)}
                          disabled={setApproval.isPending || reason.trim().length < 3}
                        >
                          {state === "expired" ? "Renew approval" : "Approve"}
                        </Button>
                      )}
                      {data.isApproved && (
                        <Button
                          variant="secondary"
                          onClick={() => void decide(false)}
                          disabled={setApproval.isPending || reason.trim().length < 3}
                        >
                          Withdraw approval
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/*
                §2 makes this directory deliberately easy to add to, which means duplicates and
                typos get in too. Until now nothing could take one out, and a directory that only
                grows is one people stop trusting. The President alone — see the order manifest.
              */}
              {mayDelete && (
                <section className="mt-5 rounded-md border border-border p-3">
                  <h3 className="text-sm font-semibold">Remove from the directory</h3>
                  <p className="mt-1 text-xs text-text-muted">
                    Refused while any purchase order or price request still points here — those
                    documents would lose the record of who they were addressed to.
                  </p>
                  <div className="mt-2">
                    <Label htmlFor="sup-delete-reason">Why</Label>
                    <Input
                      id="sup-delete-reason"
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="Duplicate of AIESSUP-0002, created by mistake."
                    />
                  </div>
                  <Button
                    className="mt-2 text-red-700"
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending || deleteReason.trim().length < 3}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete supplier
                  </Button>
                </section>
              )}

              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete ${data.name}?`}
                description={`It comes out of the directory and every picker. Reason: ${deleteReason}`}
                confirmLabel="Delete"
                destructive
                confirmPhrase={data.code}
                isPending={remove.isPending}
                onConfirm={() =>
                  void (async () => {
                    try {
                      await remove.mutateAsync({ supplierId, reason: deleteReason });
                      toastSuccess(`${data.code} ${data.name} deleted.`);
                      setConfirmDelete(false);
                      onChanged();
                      onClose();
                    } catch (error) {
                      toastError(error);
                    }
                  })()
                }
              />

              <section className="mt-5">
                <h3 className="text-sm font-semibold">History</h3>
                <div className="mt-2">
                  <AuditTrail entityType={SUPPLIER_ENTITY_TYPE} entityId={data.id} />
                </div>
              </section>

              <div className="mt-5 flex justify-end">
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}
