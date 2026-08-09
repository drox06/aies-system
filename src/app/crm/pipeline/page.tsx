"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

const BOARD_STATUSES: InquiryStatus[] = [
  "new",
  "acknowledged",
  "evaluating",
  "inspection_required",
  "quoting",
  "quoted",
];

export default function PipelinePage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const pipeline = trpc.crm.pipeline.useQuery();
  const [dragging, setDragging] = useState<{ id: string; status: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);

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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
                        {card.estimatedValue && (
                          <MoneyCell value={card.estimatedValue} currency={card.currency} />
                        )}
                        <span className="text-text-muted">{card.ownerLabel}</span>
                        <span className="text-text-muted">{card.ageDays}d</span>
                      </div>
                      {card.sla.breached && !card.acknowledgedAt && (
                        <div className="mt-1.5">
                          <StatusBadge tone="failed">SLA breached</StatusBadge>
                        </div>
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

      <p className="mt-4 text-xs text-text-muted">
        {/* Honest about what the board deliberately cannot do, rather than letting someone hunt for
            a column that is never coming. */}
        {TERMINAL_STATUSES.map(humanStatus).join(", ")} are set by the quotation&rsquo;s outcome and
        do not appear on the board.
      </p>
    </div>
  );
}
