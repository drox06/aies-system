"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MoneyCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  checkTransition,
  humanStatus,
  TERMINAL_STATUSES,
  type InquiryStatus,
} from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { CustomerPoDialog } from "./CustomerPoDialog";

/**
 * §6's kanban: "drag to advance, card shows account, value, owner, age, and a red flag if the SLA
 * is breached."
 *
 * Two things about the implementation are deliberate.
 *
 * **Native HTML5 drag, no library.** Spec.md §2: "Every dependency added must be justified." A
 * drag-and-drop library is a large one, and the whole interaction here is drag a card, drop it on a
 * column. `draggable` plus three handlers does it.
 *
 * **Drag is an enhancement, never the only route.** Spec.md §6.6 requires keyboard navigability and
 * forbids hover-dependent interactions, and HTML5 drag is neither keyboard-operable nor usable with
 * gloves on a phone. So every card is also a link to its record page, where the same transitions
 * are ordinary buttons. Dropping calls exactly the same procedure those buttons do — §3's rules,
 * the lost-reason prompt and the §4 gate all still apply, and an illegal drop is refused by the
 * server with its own message rather than by the UI guessing.
 */

/**
 * The columns, in the order work moves through them.
 *
 * `quoted` renders as **Sent** and `po_received` as **Received PO** — the company's words, mapped in
 * `humanStatus` rather than here, so the board and every other screen say the same thing.
 *
 * Why `quoted` is the "Sent" column rather than a new status: §3 already sets it from
 * `quotation.sent`, so an inquiry is `quoted` exactly when its quotation went to the customer. A
 * second status for the same fact would leave one of them permanently empty.
 */
const BOARD_STATUSES: InquiryStatus[] = [
  "new",
  "acknowledged",
  "evaluating",
  "inspection_required",
  "quoting",
  "quoted",
  "po_received",
];

export default function PipelinePage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const pipeline = trpc.crm.pipeline.useQuery();
  const [dragging, setDragging] = useState<{ id: string; status: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // The card a PO is being recorded against. Dropping into "Received PO" opens the dialog instead
  // of transitioning, because the transition is a consequence of the PO, not a thing on its own.
  const [poFor, setPoFor] = useState<string | null>(null);

  const transition = trpc.crm.transitionInquiry.useMutation({
    onSuccess: () => {
      void utils.crm.pipeline.invalidate();
      void utils.crm.listInquiries.invalidate();
    },
  });

  const cards = pipeline.data?.cards ?? [];

  async function drop(status: InquiryStatus) {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || card.status === status) return;

    // Checked locally first purely to give an instant answer on an obviously wrong drop — the
    // server checks it again regardless, and its refusal is the one that counts.
    const check = checkTransition(card.status, status);
    if (!check.ok) {
      toastError(new Error(check.reason ?? "That move is not allowed."));
      return;
    }
    if (status === "lost" || status === "won") return;

    // §3's `requiresCustomerPo`. The server refuses this move without a recorded PO, so offering the
    // form is the only way the drop can succeed — and it is what the person actually meant to do.
    if (status === "po_received") {
      setPoFor(card.id);
      return;
    }

    try {
      await transition.mutateAsync({ inquiryId: card.id, to: status });
      toastSuccess(`Moved to ${humanStatus(status)}.`);
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="mx-auto max-w-[110rem]">
      <PageHeader
        title="Pipeline"
        description="Every live inquiry. Drag a card to advance it, or open it to use the buttons."
      />

      {pipeline.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {pipeline.data?.truncated && (
        <Card className="mb-3 border-warning p-3 text-sm">
          Showing the oldest {cards.length} of {pipeline.data.total} live inquiries. The board is
          not paginated by design — if you are seeing this, it needs to be.
        </Card>
      )}

      {!pipeline.isPending && cards.length === 0 && (
        <Card className="p-4">
          <EmptyState
            title="Nothing in the pipeline."
            description="Live inquiries appear here. Won, lost and disqualified ones leave the board."
          />
        </Card>
      )}

      {cards.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {BOARD_STATUSES.map((status) => {
            const column = cards.filter((card) => card.status === status);
            const value = column.reduce((sum, card) => sum + Number(card.estimatedValue ?? 0), 0);
            return (
              <section
                key={status}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(status);
                }}
                onDragLeave={() => setOver((current) => (current === status ? null : current))}
                onDrop={(e) => {
                  e.preventDefault();
                  void drop(status);
                }}
                className={`min-w-0 rounded-md p-1 transition-colors ${
                  over === status ? "bg-surface-2 ring-2 ring-blue-400" : ""
                }`}
              >
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h2 className="text-xs font-semibold capitalize">{humanStatus(status)}</h2>
                  <span className="tabular text-xs text-text-muted">{column.length}</span>
                </div>
                {value > 0 && (
                  <p className="mb-2 text-xs text-text-muted">
                    <MoneyCell value={value} />
                  </p>
                )}

                <div className="space-y-2">
                  {column.map((card) => (
                    <article
                      key={card.id}
                      draggable
                      onDragStart={() => setDragging({ id: card.id, status: card.status })}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => router.push(`/crm/inquiries/${card.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          router.push(`/crm/inquiries/${card.id}`);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      className={`cursor-grab rounded-md border border-border bg-surface p-2.5 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none ${
                        dragging?.id === card.id ? "opacity-50" : ""
                      }`}
                    >
                      <p className="tabular text-xs text-text-muted">{card.number}</p>
                      <p className="truncate text-sm font-medium">{card.subject}</p>
                      {card.account && (
                        <p className="truncate text-xs text-text-muted">{card.account.name}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                        {card.value.amount && (
                          <>
                            <MoneyCell value={card.value.amount} currency={card.value.currency} />
                            {/* Which number this is. Without it, a card whose figure changed from
                                the intake estimate to the quoted total looks like somebody edited
                                the record — and the difference between "we think" and "they have
                                ordered" is the whole point of a pipeline. */}
                            {card.value.basis !== "estimate" && (
                              <span className="text-text-muted">{card.value.basis}</span>
                            )}
                          </>
                        )}
                        <span className="text-text-muted">{card.ownerLabel}</span>
                        <span className="text-text-muted">{card.ageDays}d</span>
                      </div>
                      {card.sla.breached && !card.acknowledgedAt && (
                        <div className="mt-1.5">
                          <StatusBadge tone="failed">SLA breached</StatusBadge>
                        </div>
                      )}
                      {card.status === "quoted" && (
                        // Not everyone can drag: Spec.md §6.6 requires keyboard operation and
                        // forbids hover-dependent interactions, and HTML5 drag is neither.
                        //
                        // Blue rather than ghost, at the company's request. Spec.md §6.3 gives blue
                        // to "every primary action", and on a card sitting in Sent this is the only
                        // thing anybody does to it — a ghost button on a white card was easy to
                        // read as a label rather than a control, which is exactly what happened.
                        <Button
                          size="sm"
                          className="mt-1.5 w-full"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPoFor(card.id);
                          }}
                        >
                          Record customer PO
                        </Button>
                      )}
                    </article>
                  ))}
                  {column.length === 0 && (
                    <p className="rounded border border-dashed border-border p-2 text-xs text-text-muted">
                      Drop here
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CustomerPoDialog
        open={poFor !== null}
        onOpenChange={(next) => setPoFor(next ? poFor : null)}
        inquiry={(() => {
          const card = cards.find((c) => c.id === poFor);
          if (!card) return null;
          return {
            id: card.id,
            number: card.number,
            subject: card.subject,
            liveQuotation: card.liveQuotation,
          };
        })()}
        onRecorded={() => {
          void utils.crm.pipeline.invalidate();
          void utils.crm.listInquiries.invalidate();
        }}
      />

      <p className="mt-4 text-xs text-text-muted">
        {/* Honest about what the board deliberately cannot do, rather than letting someone hunt for
            a column that is never coming. */}
        A card enters <strong>Sent</strong> on its own when a quotation is confirmed sent, and
        leaves it only when the customer&rsquo;s PO is recorded with its scan.{" "}
        {TERMINAL_STATUSES.map(humanStatus).join(", ")} are set by the outcome and do not appear on
        the board.
      </p>
    </div>
  );
}
