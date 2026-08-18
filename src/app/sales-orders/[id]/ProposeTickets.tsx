"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { TICKET_TYPES } from "@/server/core/operations/ticket-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §4's proposal, and the review that has to happen before anything is generated.
 *
 * The whole design of module 04's first session is in one sentence of §4: "**Do not auto-generate
 * silently — one PO can legitimately be one ticket or eight, and only a human knows which.**" So the
 * server proposes, this screen shows the proposal *and why it proposed that*, and nothing is created
 * until somebody presses the button.
 *
 * Each proposed ticket is editable in place — type, title, scope — because the common correction is
 * small: `installation` becoming `new_project`, or one ticket split in two. Making the reviewer
 * retype the whole thing to change one field is how a review becomes a rubber stamp.
 */

type Draft = {
  type: string;
  title: string;
  scopeOfWork: string;
  salesOrderLineIds: string[];
  rationale: string;
  include: boolean;
};

const human = (value: string) => value.replace(/_/g, " ");

export function ProposeTickets({
  salesOrderId,
  onGenerated,
}: {
  salesOrderId: string;
  onGenerated: () => void;
}) {
  const utils = trpc.useUtils();
  const proposal = trpc.operations.proposeTickets.useQuery({ salesOrderId }, { retry: false });
  const generate = trpc.operations.generateTickets.useMutation();

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!proposal.data) return;
    setDrafts(
      proposal.data.proposed.map((ticket) => ({
        type: ticket.type,
        title: ticket.title,
        scopeOfWork: ticket.scopeOfWork,
        salesOrderLineIds: ticket.salesOrderLineIds,
        rationale: ticket.rationale,
        include: true,
      })),
    );
  }, [proposal.data]);

  // `ticket.generate` gates it; the panel disappears for anybody else rather than erroring.
  if (proposal.error) return null;

  const data = proposal.data;
  const chosen = drafts.filter((draft) => draft.include);
  /**
   * Lines nothing would cover — excluding the ones that legitimately need nothing.
   *
   * Travel, freight and fees used to be proposed as *deliveries*, with §13's whole lane behind them:
   * a receipt to issue, a driver, a customer signature to chase for something that never arrived in
   * a van. They now propose no ticket at all, and are reported separately here — because lumping
   * them into "these lines have no ticket" trains the reviewer to ignore that warning, and then a
   * genuinely dropped line goes unnoticed.
   */
  const needsNothing = new Set((data?.needsNoTicket ?? []).map((line) => line.salesOrderLineId));
  const uncovered = (data?.lines ?? []).filter(
    (line) =>
      !line.alreadyCovered &&
      !needsNothing.has(line.salesOrderLineId) &&
      !chosen.some((draft) => draft.salesOrderLineIds.includes(line.salesOrderLineId)),
  );

  function patch(index: number, change: Partial<Draft>) {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...change } : draft)),
    );
  }

  /**
   * One more ticket than the proposal suggested.
   *
   * The proposal groups lines by what it can infer, and it cannot know that three commissioning
   * lines are three separate site visits a week apart. The company asked for the choice: "if there
   * are multiple activities, there should be a choice to generate multiple operational tickets."
   *
   * It starts empty rather than copying a neighbour, because a duplicate somebody has to remember to
   * edit is how two tickets end up with the same title and nobody can tell them apart on the board.
   */
  function addTicket() {
    setDrafts((current) => [
      ...current,
      {
        type: current[0]?.type ?? "installation",
        title: "",
        scopeOfWork: "",
        salesOrderLineIds: [],
        rationale: "Added by hand — the proposal did not suggest this one.",
        include: true,
      },
    ]);
  }

  /**
   * Moves a line onto this ticket, and off whichever one had it.
   *
   * A line covered twice would create two tickets that both claim the same work, and §2's
   * `TicketSalesOrderLine` would then disagree with itself about what is outstanding. Exclusivity
   * is enforced here so the reviewer never has to think about it.
   */
  function toggleLine(index: number, salesOrderLineId: string) {
    setDrafts((current) =>
      current.map((draft, i) => {
        const has = draft.salesOrderLineIds.includes(salesOrderLineId);
        if (i === index) {
          return {
            ...draft,
            salesOrderLineIds: has
              ? draft.salesOrderLineIds.filter((id) => id !== salesOrderLineId)
              : [...draft.salesOrderLineIds, salesOrderLineId],
          };
        }
        return has
          ? {
              ...draft,
              salesOrderLineIds: draft.salesOrderLineIds.filter((id) => id !== salesOrderLineId),
            }
          : draft;
      }),
    );
  }

  async function submit() {
    try {
      const result = await generate.mutateAsync({
        salesOrderId,
        tickets: chosen.map((draft) => ({
          type: draft.type as (typeof TICKET_TYPES)[number],
          title: draft.title,
          scopeOfWork: draft.scopeOfWork,
          salesOrderLineIds: draft.salesOrderLineIds,
        })),
      });
      toastSuccess(
        result.project
          ? `${result.tickets.length} ticket(s) generated on project ${result.project.code}.`
          : `${result.tickets.length} ticket(s) generated.`,
      );
      setOpen(false);
      void utils.operations.proposeTickets.invalidate({ salesOrderId });
      void utils.operations.listTickets.invalidate();
      onGenerated();
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Operational tickets</h2>
          <p className="mt-1 text-xs text-text-muted">
            Nothing is generated automatically. One order can be one ticket or eight, and only you
            know which.
          </p>
        </div>
        {!open && (data?.proposed.length ?? 0) > 0 && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Review proposed tickets
          </Button>
        )}
      </div>

      {(data?.existingTickets ?? []).length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {(data?.existingTickets ?? []).map((ticket) => (
            <li key={ticket.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Link
                href={`/tickets/${ticket.id}`}
                className="tabular font-medium text-blue-600 underline underline-offset-2"
              >
                {ticket.number}
              </Link>
              <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
              <StatusBadge tone="info">
                <span className="capitalize">{human(ticket.type)}</span>
              </StatusBadge>
              <StatusBadge tone="draft">
                <span className="capitalize">{human(ticket.status)}</span>
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}

      {data && data.proposed.length === 0 && data.existingTickets.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          Every line on this order is covered by a ticket.
        </p>
      )}

      {open && data && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {drafts.map((draft, index) => (
            <div
              key={index}
              className={`rounded-md border p-3 ${
                draft.include ? "border-border" : "border-dashed border-border opacity-60"
              }`}
            >
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 rounded border-border"
                  checked={draft.include}
                  onChange={(e) => patch(index, { include: e.target.checked })}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">
                    {draft.salesOrderLineIds.length} line(s) — {human(draft.type)}
                  </span>
                  {/* The reason the proposal chose this, so the reviewer is correcting a judgement
                      rather than guessing at one. */}
                  <span className="mt-0.5 block text-xs text-text-muted">{draft.rationale}</span>
                </span>
              </label>

              {draft.include && (
                <div className="mt-2 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`tkt-type-${index}`}>Type</Label>
                      <Select
                        id={`tkt-type-${index}`}
                        value={draft.type}
                        onChange={(e) => patch(index, { type: e.target.value })}
                      >
                        {TICKET_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {human(type)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor={`tkt-title-${index}`}>Title</Label>
                      <Input
                        id={`tkt-title-${index}`}
                        value={draft.title}
                        onChange={(e) => patch(index, { title: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor={`tkt-scope-${index}`}>Scope of work</Label>
                    <Textarea
                      id={`tkt-scope-${index}`}
                      rows={3}
                      value={draft.scopeOfWork}
                      onChange={(e) => patch(index, { scopeOfWork: e.target.value })}
                    />
                  </div>

                  {/* Which order lines this ticket covers. Ticking one here takes it off any other. */}
                  <div>
                    <Label htmlFor={`tkt-lines-${index}`}>Which lines does it cover</Label>
                    <div id={`tkt-lines-${index}`} className="mt-1 space-y-1">
                      {(data.lines ?? [])
                        .filter(
                          (line) =>
                            !line.alreadyCovered && !needsNothing.has(line.salesOrderLineId),
                        )
                        .map((line) => (
                          <label
                            key={line.salesOrderLineId}
                            className="flex items-start gap-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 size-4"
                              checked={draft.salesOrderLineIds.includes(line.salesOrderLineId)}
                              onChange={() => toggleLine(index, line.salesOrderLineId)}
                            />
                            <span className="min-w-0">
                              {line.lineNo}. {line.description}
                            </span>
                          </label>
                        ))}
                    </div>
                    {draft.salesOrderLineIds.length === 0 && (
                      <p className="mt-1 text-xs text-danger">
                        No lines on this ticket — it would be work with nothing behind it.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {(data.needsNoTicket ?? []).length > 0 && (
            <p className="rounded-md border border-border bg-surface-2 p-2.5 text-xs text-text-muted">
              {data.needsNoTicket.length} line(s) need no ticket — nobody goes anywhere and nothing
              is delivered:{" "}
              {data.needsNoTicket.map((line) => `${line.lineNo}. ${line.description}`).join("; ")}.
            </p>
          )}

          {uncovered.length > 0 && (
            // Reported, never refused: leaving a line off is sometimes right, and only the reviewer
            // knows. What must not happen is nobody noticing.
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              {uncovered.length} line(s) would be left with no ticket:{" "}
              {uncovered.map((line) => `${line.lineNo}. ${line.description}`).join("; ")}. That is
              fine if nobody has to do anything about them.
            </p>
          )}

          {/* My own rule from this week: never disable a control without saying why. */}
          {chosen.some((draft) => !draft.title.trim()) && (
            <p className="text-xs text-danger">
              Every ticket needs a title before these can be generated.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={addTicket}>
              Add another ticket
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                generate.isPending ||
                chosen.length === 0 ||
                chosen.some((draft) => draft.salesOrderLineIds.length === 0 || !draft.title.trim())
              }
              onClick={() => void submit()}
            >
              {generate.isPending
                ? "Generating…"
                : `Generate ${chosen.length} ticket${chosen.length === 1 ? "" : "s"}`}
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Execution tickets are grouped onto one project — three visits to the same site for this
            order share a schedule and a close-out pack. A delivery ticket never joins it.
          </p>
        </div>
      )}
    </Card>
  );
}
