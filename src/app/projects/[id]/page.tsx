"use client";

import Link from "next/link";
import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { PnlPanel } from "./PnlPanel";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { CLOSE_OUT_PACK_CONTENTS } from "@/server/core/operations/close-out-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * The project record, and §12's close-out.
 *
 * §12: "The blockers show as a checklist so the PM can see who owns each one." So the checklist shows
 * all six — cleared ones included — because a list containing only problems makes "clear"
 * indistinguishable from "nobody checked".
 */
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = trpc.operations.getProject.useQuery({ projectId: id });
  const closeOut = trpc.operations.closeOutChecklist.useQuery({ projectId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  const permissions = me.data?.permissions ?? [];
  const canManage = permissions.includes("project.manage");
  const canClose = permissions.includes("project.close");

  const [acceptanceFileId, setAcceptanceFileId] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const [lessons, setLessons] = useState("");

  const refresh = () => {
    void closeOut.refetch();
    void project.refetch();
  };

  const upsert = trpc.operations.upsertCloseOut.useMutation({ onSuccess: refresh });
  const close = trpc.operations.closeOutProject.useMutation({ onSuccess: refresh });

  if (project.isPending) return null;
  if (project.error) {
    return (
      <Card className="p-4">
        <p className="text-sm text-danger">{project.error.message}</p>
      </Card>
    );
  }

  const data = project.data;
  const state = closeOut.data;

  return (
    <div className="space-y-4">
      <PageHeader title={`${data.code} — ${data.name}`} description={data.account.name} />

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Scope</h2>
        <p className="mt-1 text-sm whitespace-pre-wrap">{data.scopeOfWork}</p>
        <p className="mt-2 text-xs text-text-muted">
          {data.status}
          {data.plannedEnd && (
            <>
              {" · planned to finish "}
              <DateCell value={data.plannedEnd} />
            </>
          )}
        </p>
      </Card>

      {/*
        §6's P&L, high on the page rather than at the bottom.

        It is the question a manager opens a project to answer, and burying it under the close-out
        checklist would make the platform's most useful number the one you have to scroll for. The
        panel renders nothing for anybody without `pnl.view`.
      */}
      <PnlPanel projectId={id} />

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Tickets</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {data.tickets.map((ticket) => (
            <li key={ticket.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link href={`/tickets/${ticket.id}`} className="hover:underline">
                <span className="tabular">{ticket.number}</span> — {ticket.title}
              </Link>
              <span className="text-xs text-text-muted">{ticket.status}</span>
            </li>
          ))}
        </ul>
        {data.tickets.length === 0 && (
          <p className="mt-1 text-sm text-text-muted">No tickets on this project.</p>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Close-out</h2>
          {state && (
            <StatusBadge tone={state.canClose ? "approved" : "pending"}>
              {state.closeOut?.status === "approved"
                ? "Closed"
                : state.canClose
                  ? "Ready to close"
                  : `${state.blockers.length} blocker(s)`}
            </StatusBadge>
          )}
        </div>

        {state && (
          <>
            <p className="mt-1 text-xs text-text-muted">{state.message}</p>

            <ul className="mt-3 space-y-2 text-sm">
              {state.checklist.map((entry) => (
                <li
                  key={entry.key}
                  className={`rounded-md border p-2.5 ${
                    entry.blocking ? "border-danger/40 bg-danger/5" : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={entry.blocking ? "font-medium text-danger" : "font-medium"}>
                      {entry.label}
                    </span>
                    <span className="text-xs text-text-muted">{entry.owner}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">{entry.detail}</p>
                </li>
              ))}
            </ul>

            {canManage && state.closeOut?.status !== "approved" && (
              <div className="mt-4 space-y-3 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">Customer acceptance</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="co-acceptance">Acceptance certificate file id</Label>
                    <Input
                      id="co-acceptance"
                      value={acceptanceFileId}
                      onChange={(e) => setAcceptanceFileId(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="co-waiver">Or why there is none</Label>
                    <Input
                      id="co-waiver"
                      placeholder="Framework agreement covers acceptance"
                      value={waiverReason}
                      onChange={(e) => setWaiverReason(e.target.value)}
                    />
                  </div>
                </div>
                {upsert.error && <p className="text-sm text-danger">{upsert.error.message}</p>}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={upsert.isPending || (!acceptanceFileId.trim() && !waiverReason.trim())}
                  onClick={() =>
                    upsert.mutate({
                      projectId: id,
                      customerAcceptanceFileId: acceptanceFileId || null,
                      acceptanceWaiverReason: waiverReason || null,
                    })
                  }
                >
                  Record it
                </Button>
              </div>
            )}

            {canClose && state.closeOut?.status !== "approved" && (
              <div className="mt-4 space-y-3 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">Hand it over</h3>
                <p className="text-xs text-text-muted">
                  Closing emits <code>project.closed</code>, which is what releases final billing.
                  §12 calls this the explicit handover — it is not a formality.
                </p>
                <div>
                  <Label htmlFor="co-lessons">Lessons learned</Label>
                  <Textarea
                    id="co-lessons"
                    rows={2}
                    value={lessons}
                    onChange={(e) => setLessons(e.target.value)}
                  />
                </div>
                {close.error && <p className="text-sm text-danger">{close.error.message}</p>}
                <Button
                  size="sm"
                  disabled={close.isPending || !state.canClose}
                  onClick={() => close.mutate({ projectId: id, lessonsLearned: lessons || null })}
                >
                  Close the project
                </Button>
                {!state.canClose && (
                  <p className="text-xs text-text-muted">
                    Blocked until the red rows above are clear.
                  </p>
                )}
              </div>
            )}

            {state.closeOut?.approvedAt && (
              <p className="mt-3 text-xs text-text-muted">
                Closed <DateCell value={state.closeOut.approvedAt} />.
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Close-out pack</h2>
          {/* Provisional while blockers are open — the document prints its own banner saying so. */}
          <a
            href={`/api/projects/${id}/close-out-pdf`}
            className="text-xs underline"
            target="_blank"
            rel="noreferrer"
          >
            Download the pack
          </a>
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          §12 wants these assembled as one indexed PDF and filed as a controlled document. The
          generator is not built yet — this is the list it will walk.
        </p>
        <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-sm sm:grid-cols-2">
          {CLOSE_OUT_PACK_CONTENTS.map((item) => (
            <li key={item} className="text-text-muted">
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
