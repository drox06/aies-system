"use client";

import { useState } from "react";
import Link from "next/link";
import { enqueue } from "@/lib/offline/outbox";
import { attachPhoto, browserUpload, uploadPending } from "@/lib/offline/attachments";
import { useSync, describeAge } from "@/lib/offline/use-sync";
import {
  ATTEMPT_FAILURE_CAUSES,
  ATTEMPT_FAILURE_LABELS,
  type AttemptFailureCause,
} from "@/server/core/operations/delivery-rules";
import { trpc } from "@/lib/trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/api/root";

/** Straight off the router, so the screen cannot drift from what the query actually returns. */
type Drop = inferRouterOutputs<AppRouter>["operations"]["todaysDrops"]["drops"][number];

/**
 * specs/04-operations-projects.md §14's delivery mode.
 *
 * "A distinct, stripped-down screen for drivers: today's drops, navigate, log attempt, capture
 * signature. **Nothing else.**"
 *
 * The "nothing else" is the requirement, not the preamble. Every control that is not one of those
 * four is something to mis-tap while holding a box, in sunlight, next to a running truck. So there is
 * no sidebar, no search, no notification bell, no breadcrumb — the app shell is deliberately absent
 * here and the only way back to the rest of the platform is one explicit link at the bottom.
 *
 * §14's UI constraints are load-bearing rather than decorative: "large touch targets, high contrast
 * for outdoor screens, minimal typing, one-handed use". Which is why the failure causes are buttons
 * rather than a select, the primary actions sit at the bottom of the screen where a thumb reaches,
 * and the only free-text field on the page is optional.
 */

export default function FieldPage() {
  const drops = trpc.operations.todaysDrops.useQuery(undefined, {
    /*
      The list is worth having stale — a driver who opened it in the yard should still see their run
      after losing signal on the road, and refetching on focus would blank it.

      That reasoning stands, and it had a cost nobody had paid yet: **there was no way to ask for a
      fresh list.** The office issues a delivery receipt, and the driver who opened this screen five
      minutes earlier sees nothing for half an hour, with nothing on screen admitting the list is
      old. Reported on 2026-08-19 — the fourth time this screen has come up empty, and the first
      time the data underneath it was actually correct.

      So the staleness stays and a Refresh button sits beside it, with the time the list was
      fetched. A driver can now tell "nothing to take out" from "this is what was true at 09:14".
    */
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    // Regaining signal is the one moment a driver most wants the office's latest, and the least
    // likely to have a spare hand for a button.
    refetchOnReconnect: "always",
    retry: false,
  });

  const logAttempt = trpc.operations.logDeliveryAttempt.useMutation();

  const sync = useSync(async (item) => {
    try {
      // Photos before the write, always. A write that landed first would reference photographs that
      // may never arrive — a record that looks complete and is not.
      const payload = item.payload as Parameters<typeof logAttempt.mutateAsync>[0];
      const photoFileIds = await uploadPending(
        item.clientUuid,
        browserUpload("DeliveryTicketFlow", payload.ticketId),
      );

      await logAttempt.mutateAsync({
        ...payload,
        photoFileIds: photoFileIds.length > 0 ? photoFileIds : undefined,
        clientUuid: item.clientUuid,
        capturedAt: new Date(item.capturedAt),
      });
      return {};
    } catch (error) {
      // A business rule's refusal is final and belongs on screen; anything else is the network, and
      // rethrowing keeps the item queued for the next try. The distinction is the whole reason the
      // queue has separate `rejected` and `failed` states.
      const message = error instanceof Error ? error.message : String(error);
      if (/BAD_REQUEST|refused|cannot|must|Say why/i.test(message)) {
        return { rejected: true, reason: message };
      }
      throw error;
    }
  });

  const [openDrop, setOpenDrop] = useState<string | null>(null);

  return (
    <div className="min-h-dvh bg-white text-black">
      {/* §14's persistent indicator. Fixed, so the answer to "is my work safe?" never scrolls away. */}
      <header className="sticky top-0 z-10 border-b-2 border-black bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-lg font-bold">Deliveries</p>
            <p className="text-sm">
              {sync.queued > 0 ? (
                <span className="font-semibold">
                  {sync.queued} waiting to send
                  {describeAge(sync.oldestCapturedAt)
                    ? ` · oldest ${describeAge(sync.oldestCapturedAt)}`
                    : ""}
                </span>
              ) : (
                "Everything sent"
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void sync.sync()}
            disabled={sync.syncing}
            className="min-h-12 rounded-lg border-2 border-black px-4 text-base font-semibold active:bg-black active:text-white disabled:opacity-50"
          >
            {sync.syncing ? "Sending…" : "Send now"}
          </button>
        </div>

        {/* §14's storage guard. Warns; never makes room by deleting what cannot be recovered. */}
        {sync.storageWarn && (
          <p className="mt-2 border-2 border-black p-2 text-sm font-semibold">
            Storage is {sync.storagePct}% full. Send your queue soon — nothing will be deleted, but
            new photos may fail to save.
          </p>
        )}

        {sync.rejected > 0 && (
          <p className="mt-2 border-2 border-black bg-black p-2 text-sm font-semibold text-white">
            {sync.rejected} item{sync.rejected === 1 ? "" : "s"} could not be accepted. Tap below to
            read why — nothing has been thrown away.
          </p>
        )}
      </header>

      {/* Refusals first: this is somebody's work that did not happen, and they do not know yet. */}
      {sync.items.filter((item) => item.status === "rejected").length > 0 && (
        <section className="border-b-2 border-black p-4">
          <h2 className="text-base font-bold">Not accepted</h2>
          <ul className="mt-2 space-y-2">
            {sync.items
              .filter((item) => item.status === "rejected")
              .map((item) => (
                <li key={item.clientUuid} className="border-2 border-black p-3">
                  <p className="font-semibold">{item.label}</p>
                  <p className="mt-1 text-sm">{item.rejectionReason}</p>
                </li>
              ))}
          </ul>
        </section>
      )}

      <main className="p-4">
        {/*
          When this list was fetched, and how to get a newer one.

          Big enough for a gloved thumb per §14, and stating the time rather than "just now" —
          a relative label would need re-rendering to stay true and would lie quietly when it did
          not. `isFetching` rather than `isPending`, so the button reports a background refetch
          instead of appearing to do nothing.
        */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm">
            {drops.dataUpdatedAt
              ? `As of ${new Date(drops.dataUpdatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : "Not loaded yet"}
          </p>
          <button
            type="button"
            className="border-2 border-black px-4 py-3 text-base font-semibold disabled:opacity-50"
            disabled={drops.isFetching}
            onClick={() => void drops.refetch()}
          >
            {drops.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {drops.isPending && <p className="text-base">Loading your run…</p>}
        {drops.error && (
          <p className="border-2 border-black p-3 text-base">
            Could not load today&rsquo;s drops. Anything you record is still saved on this phone and
            will send when you have signal.
          </p>
        )}

        {drops.data?.drops.length === 0 && (
          <div className="text-base">
            <p>Nothing to take out right now.</p>
            <p className="mt-1 text-sm">
              This list is held for up to half an hour so it survives losing signal. If the office
              has just issued a receipt, press Refresh.
            </p>
            {drops.data.awaitingReceipt > 0 && (
              <p className="mt-2 border-2 border-black p-3 font-semibold">
                {drops.data.awaitingReceipt} delivery
                {drops.data.awaitingReceipt === 1 ? " is" : " deliveries are"} waiting for the
                delivery receipt. The office issues it —{" "}
                {drops.data.awaitingReceipt === 1 ? "it" : "they"} will appear here once it is out.
              </p>
            )}
          </div>
        )}

        <ul className="space-y-3">
          {(drops.data?.drops ?? []).map((drop) => (
            <li key={drop.flowId} className="border-2 border-black">
              <button
                type="button"
                onClick={() => setOpenDrop(openDrop === drop.flowId ? null : drop.flowId)}
                className="min-h-16 w-full px-4 py-3 text-left"
              >
                <p className="text-lg font-bold">{drop.customer ?? drop.ticketNumber}</p>
                <p className="text-base">{drop.siteName ?? drop.title}</p>
                {drop.attemptCount > 0 && (
                  <p className="mt-1 text-sm font-semibold">
                    Attempt {drop.attemptCount + 1}
                    {drop.lastFailure
                      ? ` · last time: ${ATTEMPT_FAILURE_LABELS[drop.lastFailure as AttemptFailureCause]}`
                      : ""}
                  </p>
                )}
              </button>

              {openDrop === drop.flowId && (
                <DropDetail
                  drop={drop}
                  onQueued={() => {
                    setOpenDrop(null);
                    void sync.refresh();
                    void sync.sync();
                  }}
                />
              )}
            </li>
          ))}
        </ul>

        <p className="mt-8 text-center">
          <Link href="/crm/my-day" className="text-base underline">
            Leave delivery mode
          </Link>
        </p>
      </main>
    </div>
  );
}

function DropDetail({ drop, onQueued }: { drop: Drop; onQueued: () => void }) {
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);

  const queue = async (payload: Record<string, unknown>) => {
    const clientUuid = await enqueue({
      procedure: "operations.logDeliveryAttempt",
      operation: "delivery.attempt",
      payload: { ticketId: drop.ticketId, notes: notes || null, ...payload },
      label: `${drop.customer ?? drop.ticketNumber} — ${drop.ticketNumber}`,
    });

    // Moved onto the queued item now that it has an id. Taken before the outcome is known, because
    // a driver photographs the closed gate first and decides what to tap second.
    for (const file of photos) {
      await attachPhoto(clientUuid, file);
    }
    onQueued();
  };

  return (
    <div className="border-t-2 border-black p-4">
      {drop.address && (
        <>
          <p className="text-base">{drop.address}</p>
          {/* §14 asks for "navigate". A maps link is the whole feature — it hands off to the app the
              driver already knows, rather than building a worse map inside this one. */}
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(drop.address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-12 items-center rounded-lg border-2 border-black px-4 font-semibold"
          >
            Navigate
          </a>
        </>
      )}

      {drop.accessNotes && (
        <p className="mt-3 border-2 border-black p-2 text-sm">
          <span className="font-bold">Access: </span>
          {drop.accessNotes}
        </p>
      )}

      {drop.lines.length > 0 && (
        <ul className="mt-3 space-y-1 text-base">
          {drop.lines.map((line, index) => (
            <li key={index}>
              {line.quantity} {line.unit} — {line.description}
            </li>
          ))}
        </ul>
      )}

      {/* §14: "minimal typing". A photograph is the fastest true thing a driver can record, and
          `capture` opens the camera rather than a file browser. */}
      <label className="mt-4 block">
        <span className="text-sm font-semibold">Photos</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(event) => setPhotos(Array.from(event.target.files ?? []))}
          className="mt-1 block w-full text-base"
        />
        {photos.length > 0 && (
          <span className="mt-1 block text-sm font-semibold">
            {photos.length} photo{photos.length === 1 ? "" : "s"} will be saved with this
          </span>
        )}
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-semibold">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={2}
          className="mt-1 w-full border-2 border-black p-2 text-base"
        />
      </label>

      <button
        type="button"
        onClick={() => void queue({ contactReached: true, itemDelivered: true, drSigned: true })}
        className="mt-4 min-h-14 w-full rounded-lg border-2 border-black bg-black text-lg font-bold text-white active:opacity-80"
      >
        Delivered and signed
      </button>

      <p className="mt-4 text-sm font-semibold">Could not deliver — why?</p>
      <div className="mt-2 grid grid-cols-1 gap-2">
        {ATTEMPT_FAILURE_CAUSES.map((cause) => (
          <button
            key={cause}
            type="button"
            onClick={() =>
              void queue({
                contactReached: false,
                itemDelivered: false,
                drSigned: false,
                failureReason: cause,
              })
            }
            className="min-h-14 rounded-lg border-2 border-black px-4 text-base font-semibold active:bg-black active:text-white"
          >
            {ATTEMPT_FAILURE_LABELS[cause]}
          </button>
        ))}
      </div>

      <p className="mt-3 text-sm">
        Whatever you tap is saved on this phone straight away. It sends itself when you have signal.
      </p>
    </div>
  );
}
