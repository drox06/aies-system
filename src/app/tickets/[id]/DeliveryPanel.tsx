"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ATTEMPT_FAILURE_CAUSES,
  ATTEMPT_FAILURE_LABELS,
  DELIVERY_FLOW_ENTITY_TYPE,
  DELIVERY_MODES,
  DELIVERY_MODE_LABELS,
  DELIVERY_RECEIPT_ENTITY_TYPE,
  DELIVERY_STATUS_LABELS,
  canComplete,
  canLeaveForSite,
  checkAttempt,
  type AttemptFailureCause,
  type DeliveryMode,
} from "@/server/core/operations/delivery-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §13's delivery lane, on the ticket.
 *
 * The screen is arranged around the two gates rather than around the data. §13.1 says no DR means no
 * movement, so until a receipt exists the only thing offered is issuing one — a "mobilise" button
 * that throws is a worse answer than a button that is not there. And the completion form is behind
 * the signature, not beside it, because §13.2's rule is the one with money attached: a courier's
 * proof of delivery is not a signed AIES receipt, and the panel must not let the two look alike.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  dr_requested: "pending",
  dr_issued: "pending",
  mobilized: "active",
  attempting: "active",
  in_transit: "active",
  delivered_unsigned: "failed",
  completed: "approved",
  failed: "failed",
  rescheduled: "pending",
};

interface DraftLine {
  salesOrderLineId: string;
  description: string;
  quantity: string;
  unit: string;
  include: boolean;
}

export function DeliveryPanel({ ticketId, ticketType }: { ticketId: string; ticketType: string }) {
  const flow = trpc.operations.getDeliveryFlow.useQuery({ ticketId });
  const deliverable = trpc.operations.deliverableLines.useQuery(
    { ticketId },
    { enabled: ticketType === "delivery" },
  );
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  // What is attached, so the signature can be *chosen* rather than typed as an id. A driver on a
  // phone at a customer's gate cannot copy a cuid across from another panel, and §14's offline PWA
  // makes this screen the one that most has to work in that hand.
  const podFiles = trpc.files.forEntity.useQuery(
    { entityType: DELIVERY_FLOW_ENTITY_TYPE, entityId: flow.data?.id ?? "" },
    { enabled: Boolean(flow.data?.id) },
  );
  const receiptFiles = trpc.files.forEntity.useQuery(
    {
      entityType: DELIVERY_RECEIPT_ENTITY_TYPE,
      entityId: flow.data?.deliveryReceiptId ?? "",
    },
    { enabled: Boolean(flow.data?.deliveryReceiptId) },
  );

  const canExecute = (me.data?.permissions ?? []).includes("delivery.execute");
  const refresh = () => void flow.refetch();

  const start = trpc.operations.startDeliveryFlow.useMutation({ onSuccess: refresh });
  const setMode = trpc.operations.setDeliveryMode.useMutation({ onSuccess: refresh });
  const issue = trpc.operations.issueDeliveryReceipt.useMutation({ onSuccess: refresh });
  const mobilize = trpc.operations.mobilizeDelivery.useMutation({ onSuccess: refresh });
  const logAttempt = trpc.operations.logDeliveryAttempt.useMutation({ onSuccess: refresh });
  const book = trpc.operations.bookCourier.useMutation({ onSuccess: refresh });
  const recordPod = trpc.operations.recordCourierPod.useMutation({ onSuccess: refresh });
  const complete = trpc.operations.completeDelivery.useMutation({ onSuccess: refresh });

  const [lines, setLines] = useState<DraftLine[] | null>(null);
  const [vehicleRef, setVehicleRef] = useState("");
  const [driverName, setDriverName] = useState("");

  // The visit. Kept as one piece of state because §13.1 treats it as one act — the driver arrives and
  // either hands the goods over or does not, and splitting it into two forms would invite a record
  // where the outcome and the reason disagree.
  const [contactSought, setContactSought] = useState("");
  const [contactReached, setContactReached] = useState(true);
  const [itemDelivered, setItemDelivered] = useState(true);
  const [drSigned, setDrSigned] = useState(true);
  const [failureReason, setFailureReason] = useState<AttemptFailureCause | "">("");
  const [attemptNotes, setAttemptNotes] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPosition, setRecipientPosition] = useState("");
  const [signatureFileId, setSignatureFileId] = useState("");

  const [courierName, setCourierName] = useState("");
  const [waybillNumber, setWaybillNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [freightPesos, setFreightPesos] = useState("");
  const [podFileId, setPodFileId] = useState("");
  const [courierRecipient, setCourierRecipient] = useState("");

  if (ticketType !== "delivery") return null;
  if (flow.isPending) return null;
  if (flow.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{flow.error.message}</p>
      </Card>
    );
  }

  const data = flow.data;
  const busy =
    start.isPending ||
    issue.isPending ||
    mobilize.isPending ||
    logAttempt.isPending ||
    book.isPending ||
    recordPod.isPending ||
    complete.isPending;

  const errorOf = (...mutations: { error: { message: string } | null }[]): string | null =>
    mutations.find((m) => m.error)?.error?.message ?? null;

  const message = errorOf(start, setMode, issue, mobilize, logAttempt, book, recordPod, complete);

  if (!data) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Delivery</h2>
        <p className="mt-1 text-sm text-text-muted">
          Nothing has been raised yet. Opening the lane requests the delivery receipt this ticket
          will be executed against — nothing moves until it exists.
        </p>
        {canExecute && (
          <div className="mt-3 flex flex-wrap gap-2">
            {DELIVERY_MODES.map((mode) => (
              <Button
                key={mode}
                variant={mode === "own_vehicle" ? "primary" : "secondary"}
                disabled={busy}
                onClick={() => start.mutate({ ticketId, mode })}
              >
                Start — {DELIVERY_MODE_LABELS[mode].toLowerCase()}
              </Button>
            ))}
          </div>
        )}
        {message && <p className="mt-2 text-sm text-danger">{message}</p>}
      </Card>
    );
  }

  const mode = data.mode as DeliveryMode;
  const gate = canLeaveForSite({ mode, drIssuedAt: data.drIssuedAt });
  const completion = canComplete({
    mode,
    courierPodFileId: data.courierPodFileId,
    drSignedAt: data.completedAt,
  });
  const modeLocked = Boolean(data.mobilizedAt || data.bookedAt);
  const done = data.status === "completed";

  const attemptCheck = checkAttempt({
    itemDelivered,
    drSigned,
    contactReached,
    failureReason: failureReason || null,
  });

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Delivery</h2>
        <StatusBadge tone={STATUS_TONE[data.status] ?? "pending"}>
          {DELIVERY_STATUS_LABELS[data.status as keyof typeof DELIVERY_STATUS_LABELS] ??
            data.status}
        </StatusBadge>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2">
          <dt className="text-text-muted">Mode</dt>
          <dd>{DELIVERY_MODE_LABELS[mode]}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-text-muted">Receipt</dt>
          <dd>{data.receipt?.number ?? "Not issued"}</dd>
        </div>
        {data.deliveredAt && (
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Delivered</dt>
            <dd>
              <DateCell value={data.deliveredAt} />
            </dd>
          </div>
        )}
        {data.completedAt && (
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Signed</dt>
            <dd>
              <DateCell value={data.completedAt} />
            </dd>
          </div>
        )}
      </dl>

      {/*
        The billing risk, said where it is happening rather than only in a nightly email. The goods
        are with the customer and AIES cannot invoice — this is the one state on this screen that
        costs money for every day it stays.
      */}
      {data.status === "delivered_unsigned" && (
        <p className="mt-3 rounded-md border-2 border-amber-400 bg-amber-50 p-2.5 text-sm text-amber-900">
          Delivered, unsigned. AIES cannot invoice this until the signed delivery receipt comes
          back.
          {data.unsignedEscalatedAt && " This has already been escalated."}
        </p>
      )}

      {canExecute && !modeLocked && !done && (
        <div className="mt-3 flex items-end gap-2">
          <div className="w-48">
            <Label htmlFor="delivery-mode">Mode</Label>
            <Select
              id="delivery-mode"
              value={mode}
              onChange={(event) =>
                setMode.mutate({ ticketId, mode: event.target.value as DeliveryMode })
              }
            >
              {DELIVERY_MODES.map((option) => (
                <option key={option} value={option}>
                  {DELIVERY_MODE_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
          <p className="pb-2 text-xs text-text-muted">Changeable until dispatch.</p>
        </div>
      )}

      {/* ---- the gate: §13.1 step 2 ---- */}
      {!data.drIssuedAt && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">Issue the delivery receipt</h3>
          <p className="mt-1 text-xs text-text-muted">{gate.errors.join(" ")}</p>

          {deliverable.data?.lines.length ? (
            <>
              <ul className="mt-2 space-y-2">
                {(
                  lines ??
                  deliverable.data.lines.map((line) => ({
                    salesOrderLineId: line.salesOrderLineId,
                    description: line.description,
                    quantity: line.outstanding,
                    unit: line.unit,
                    include: true,
                  }))
                ).map((line, index) => (
                  <li key={line.salesOrderLineId} className="flex flex-wrap items-end gap-2">
                    <label className="flex items-center gap-1.5 pb-2 text-sm">
                      <input
                        type="checkbox"
                        checked={line.include}
                        onChange={(event) =>
                          setLines((current) => {
                            const base =
                              current ??
                              deliverable.data!.lines.map((row) => ({
                                salesOrderLineId: row.salesOrderLineId,
                                description: row.description,
                                quantity: row.outstanding,
                                unit: row.unit,
                                include: true,
                              }));
                            return base.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, include: event.target.checked } : row,
                            );
                          })
                        }
                      />
                      Deliver
                    </label>
                    <div className="min-w-[16rem] flex-1">
                      <Label htmlFor={`dr-desc-${index}`}>Description</Label>
                      <Input
                        id={`dr-desc-${index}`}
                        value={line.description}
                        onChange={(event) =>
                          setLines((current) => {
                            const base = current ?? [];
                            return base.map((row, rowIndex) =>
                              rowIndex === index
                                ? { ...row, description: event.target.value }
                                : row,
                            );
                          })
                        }
                      />
                    </div>
                    <div className="w-24">
                      <Label htmlFor={`dr-qty-${index}`}>Qty</Label>
                      <Input
                        id={`dr-qty-${index}`}
                        value={line.quantity}
                        onChange={(event) =>
                          setLines((current) => {
                            const base = current ?? [];
                            return base.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, quantity: event.target.value } : row,
                            );
                          })
                        }
                      />
                    </div>
                    <div className="w-20">
                      <Label htmlFor={`dr-unit-${index}`}>Unit</Label>
                      <Input
                        id={`dr-unit-${index}`}
                        value={line.unit}
                        onChange={(event) =>
                          setLines((current) => {
                            const base = current ?? [];
                            return base.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, unit: event.target.value } : row,
                            );
                          })
                        }
                      />
                    </div>
                  </li>
                ))}
              </ul>

              {canExecute && (
                <Button
                  className="mt-3"
                  disabled={busy}
                  onClick={() => {
                    const source =
                      lines ??
                      deliverable.data!.lines.map((line) => ({
                        salesOrderLineId: line.salesOrderLineId,
                        description: line.description,
                        quantity: line.outstanding,
                        unit: line.unit,
                        include: true,
                      }));
                    issue.mutate({
                      ticketId,
                      salesOrderId: deliverable.data!.salesOrderId!,
                      lines: source
                        .filter((line) => line.include)
                        .map(({ salesOrderLineId, description, quantity, unit }) => ({
                          salesOrderLineId,
                          description,
                          quantity,
                          unit,
                        })),
                    });
                  }}
                >
                  Issue receipt
                </Button>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-text-muted">
              This ticket has no sales order lines to deliver against.
            </p>
          )}
        </div>
      )}

      {/* ---- own vehicle ---- */}
      {data.drIssuedAt && mode === "own_vehicle" && !done && canExecute && (
        <div className="mt-4 border-t border-border pt-3">
          {!data.mobilizedAt ? (
            <>
              <h3 className="text-sm font-semibold">Send the crew</h3>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="w-40">
                  <Label htmlFor="vehicle-ref">Vehicle</Label>
                  <Input
                    id="vehicle-ref"
                    value={vehicleRef}
                    onChange={(event) => setVehicleRef(event.target.value)}
                  />
                </div>
                <div className="w-48">
                  <Label htmlFor="driver-name">Driver</Label>
                  <Input
                    id="driver-name"
                    value={driverName}
                    onChange={(event) => setDriverName(event.target.value)}
                  />
                </div>
                <Button
                  disabled={busy}
                  onClick={() =>
                    mobilize.mutate({
                      ticketId,
                      vehicleRef: vehicleRef || null,
                      driverName: driverName || null,
                    })
                  }
                >
                  Mobilise
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold">Log a visit</h3>
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={contactReached}
                      onChange={(event) => setContactReached(event.target.checked)}
                    />
                    Contact reached
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={itemDelivered}
                      onChange={(event) => {
                        setItemDelivered(event.target.checked);
                        if (!event.target.checked) setDrSigned(false);
                      }}
                    />
                    Goods handed over
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={drSigned}
                      disabled={!itemDelivered}
                      onChange={(event) => setDrSigned(event.target.checked)}
                    />
                    Receipt signed
                  </label>
                </div>

                <div className="w-56">
                  <Label htmlFor="contact-sought">Who was asked for</Label>
                  <Input
                    id="contact-sought"
                    value={contactSought}
                    onChange={(event) => setContactSought(event.target.value)}
                  />
                </div>

                {/* §13.3 counts these, which is only possible because it is a code and not a sentence. */}
                {!itemDelivered && (
                  <div className="w-72">
                    <Label htmlFor="failure-reason">Why it failed</Label>
                    <Select
                      id="failure-reason"
                      value={failureReason}
                      onChange={(event) =>
                        setFailureReason(event.target.value as AttemptFailureCause | "")
                      }
                    >
                      <option value="">Choose a reason…</option>
                      {ATTEMPT_FAILURE_CAUSES.map((cause) => (
                        <option key={cause} value={cause}>
                          {ATTEMPT_FAILURE_LABELS[cause]}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                {itemDelivered && (
                  <div className="flex flex-wrap gap-2">
                    <div className="w-48">
                      <Label htmlFor="recipient-name">Received by</Label>
                      <Input
                        id="recipient-name"
                        value={recipientName}
                        onChange={(event) => setRecipientName(event.target.value)}
                      />
                    </div>
                    <div className="w-48">
                      <Label htmlFor="recipient-position">Position</Label>
                      <Input
                        id="recipient-position"
                        value={recipientPosition}
                        onChange={(event) => setRecipientPosition(event.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <Label htmlFor="attempt-notes">Notes</Label>
                  <Textarea
                    id="attempt-notes"
                    rows={2}
                    value={attemptNotes}
                    onChange={(event) => setAttemptNotes(event.target.value)}
                  />
                </div>

                {attemptCheck.warnings.length > 0 && (
                  <p className="text-sm text-amber-700">{attemptCheck.warnings.join(" ")}</p>
                )}
                {!attemptCheck.ok && (
                  <p className="text-sm text-danger">{attemptCheck.errors.join(" ")}</p>
                )}

                <Button
                  disabled={busy || !attemptCheck.ok}
                  onClick={() =>
                    logAttempt.mutate({
                      ticketId,
                      contactPersonSought: contactSought || null,
                      contactReached,
                      itemDelivered,
                      drSigned,
                      failureReason: failureReason || null,
                      notes: attemptNotes || null,
                      recipientName: recipientName || null,
                      recipientPosition: recipientPosition || null,
                    })
                  }
                >
                  Record visit
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- courier ---- */}
      {data.drIssuedAt && mode === "courier" && !done && canExecute && (
        <div className="mt-4 border-t border-border pt-3">
          {!data.bookedAt ? (
            <>
              <h3 className="text-sm font-semibold">Book the shipment</h3>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="w-44">
                  <Label htmlFor="courier-name">Courier</Label>
                  <Input
                    id="courier-name"
                    value={courierName}
                    onChange={(event) => setCourierName(event.target.value)}
                  />
                </div>
                <div className="w-44">
                  <Label htmlFor="waybill">Waybill</Label>
                  <Input
                    id="waybill"
                    value={waybillNumber}
                    onChange={(event) => setWaybillNumber(event.target.value)}
                  />
                </div>
                <div className="w-56">
                  <Label htmlFor="tracking-url">Tracking URL</Label>
                  <Input
                    id="tracking-url"
                    value={trackingUrl}
                    onChange={(event) => setTrackingUrl(event.target.value)}
                  />
                </div>
                {/* §13.2 step 6: "routinely forgotten in margin", so it is asked for at booking. */}
                <div className="w-36">
                  <Label htmlFor="freight-cost">Freight (₱)</Label>
                  <Input
                    id="freight-cost"
                    value={freightPesos}
                    onChange={(event) => setFreightPesos(event.target.value)}
                  />
                </div>
                <Button
                  disabled={busy || !courierName || !waybillNumber}
                  onClick={() =>
                    book.mutate({
                      ticketId,
                      courierName,
                      waybillNumber,
                      trackingUrl: trackingUrl || null,
                      freightCost: freightPesos ? Math.round(Number(freightPesos) * 100) : null,
                    })
                  }
                >
                  Book
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold">Courier proof of delivery</h3>
              <p className="mt-1 text-xs text-text-muted">
                The courier&rsquo;s POD says a box arrived. It does not close this ticket — only the
                signed AIES receipt does.
              </p>
              <Attachments
                entityType={DELIVERY_FLOW_ENTITY_TYPE}
                entityId={data.id}
                label="POD"
                category="operations"
                compact
                onChanged={() => void podFiles.refetch()}
              />
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="w-56">
                  <Label htmlFor="pod-file">Which file is the POD</Label>
                  <Select
                    id="pod-file"
                    value={podFileId}
                    onChange={(event) => setPodFileId(event.target.value)}
                  >
                    <option value="">Choose an attachment…</option>
                    {(podFiles.data ?? []).map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.filename}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-48">
                  <Label htmlFor="courier-recipient">Signed for by</Label>
                  <Input
                    id="courier-recipient"
                    value={courierRecipient}
                    onChange={(event) => setCourierRecipient(event.target.value)}
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={busy || !podFileId}
                  onClick={() =>
                    recordPod.mutate({
                      ticketId,
                      courierPodFileId: podFileId,
                      courierRecipientName: courierRecipient || null,
                    })
                  }
                >
                  Record POD
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- completion: the signed receipt, whichever way it travelled ---- */}
      {data.drIssuedAt && !done && canExecute && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">Signed delivery receipt</h3>
          <p className="mt-1 text-xs text-text-muted">
            {completion.ok
              ? "Ready to close."
              : "Upload the signed receipt to close the delivery and release billing."}
          </p>
          <Attachments
            entityType={DELIVERY_RECEIPT_ENTITY_TYPE}
            entityId={data.deliveryReceiptId ?? data.id}
            label="Signed receipt"
            category="operations"
            compact
            onChanged={() => void receiptFiles.refetch()}
          />
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-56">
              <Label htmlFor="signature-file">Which file is the signed copy</Label>
              <Select
                id="signature-file"
                value={signatureFileId}
                onChange={(event) => setSignatureFileId(event.target.value)}
              >
                <option value="">Choose an attachment…</option>
                {(receiptFiles.data ?? []).map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.filename}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-48">
              <Label htmlFor="signed-by">Signed by</Label>
              <Input
                id="signed-by"
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
              />
            </div>
            <div className="w-48">
              <Label htmlFor="signed-position">Position</Label>
              <Input
                id="signed-position"
                value={recipientPosition}
                onChange={(event) => setRecipientPosition(event.target.value)}
              />
            </div>
            <Button
              disabled={busy || !signatureFileId || !recipientName}
              onClick={() =>
                complete.mutate({
                  ticketId,
                  recipientName,
                  recipientPosition: recipientPosition || null,
                  signatureFileId,
                })
              }
            >
              Close delivery
            </Button>
          </div>
        </div>
      )}

      {/* ---- the history §13.3 reads ---- */}
      {data.attempts.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">Visits</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {data.attempts.map((entry) => (
              <li key={entry.attemptNo} className="flex flex-wrap items-baseline gap-2">
                <span className="text-text-muted">#{entry.attemptNo}</span>
                <DateCell value={entry.at} />
                <span>
                  {entry.itemDelivered
                    ? entry.drSigned
                      ? "Delivered and signed"
                      : "Delivered, unsigned"
                    : (entry.failureReason &&
                        ATTEMPT_FAILURE_LABELS[entry.failureReason as AttemptFailureCause]) ||
                      "Failed"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-danger">{message}</p>}
    </Card>
  );
}
