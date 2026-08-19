"use client";

import { useState } from "react";
import Link from "next/link";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { METHODOLOGY_ENTITY_TYPE } from "@/server/core/operations/methodology-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §6.2's gate on the ticket.
 *
 * §6.2: "**The client approves the methodology before work starts. Always.**" So this shows the
 * verdict whether or not the reader can act on it — a coordinator who cannot write a method
 * statement still needs to know the crew is not going anywhere until the customer signs.
 *
 * The turnaround line is the commercially useful part. §6.2: "Client methodology approval is a
 * common and invisible source of schedule slip, and AIES is usually blamed for delays it did not
 * cause. A dated submission record changes that conversation."
 */

const GATE_TONE: Record<string, StatusTone> = {
  not_required: "draft",
  satisfied: "approved",
  blocked: "failed",
};

export function MethodologyPanel({
  ticketId,
  ticketTitle,
  projectId,
}: {
  ticketId: string;
  ticketTitle: string;
  projectId: string | null;
}) {
  const gate = trpc.operations.methodologyGate.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showForm, setShowForm] = useState(false);

  const permissions = me.data?.permissions ?? [];
  const canPrepare = permissions.includes("methodology.prepare");
  const canOverride = permissions.includes("operations.override_methodology_gate");

  if (gate.isPending) return null;
  if (gate.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{gate.error.message}</p>
      </Card>
    );
  }

  const data = gate.data;
  const refresh = () => void gate.refetch();

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Method statement</h2>
        <StatusBadge tone={GATE_TONE[data.state] ?? "draft"}>
          {data.state === "blocked"
            ? "Mobilisation blocked"
            : data.state === "satisfied"
              ? "Clear"
              : "Approval waived"}
        </StatusBadge>
      </div>

      <p className="mt-1 text-sm text-text-muted">{data.message}</p>

      {data.methodology && (
        <p className="mt-2 flex flex-wrap items-baseline gap-2 text-sm">
          <Link
            href={`/methodologies/${data.methodology.id}`}
            className="tabular text-blue-600 underline underline-offset-2"
          >
            {data.methodology.number} R{data.methodology.revision}
          </Link>
          <span className="text-xs text-text-muted capitalize">
            {data.methodology.status.replace(/_/g, " ")}
          </span>
          {data.methodology.turnaround.days !== null && (
            <span
              className={
                data.methodology.turnaround.pending
                  ? "text-xs text-amber-800"
                  : "text-xs text-text-muted"
              }
            >
              {data.methodology.turnaround.message}
            </span>
          )}
        </p>
      )}

      {canPrepare && !data.methodology && !showForm && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowForm(true)}>
          Write a method statement
        </Button>
      )}

      {showForm && (
        <CreateForm
          ticketId={ticketId}
          projectId={projectId}
          defaultTitle={`Method statement — ${ticketTitle}`}
          onDone={() => {
            setShowForm(false);
            refresh();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/*
        The method statement paperwork, whoever's form it is on.
        ============================================================================

        §6.2's gate is "approved by the client", and what proves that is a document with their name
        on it. That document arrives in one of two shapes, and the first version of this panel only
        allowed for one of them:

          - **our** method statement, returned signed; or
          - **theirs** — the plant's own permit-to-work or method-of-statement form, which they made
            us complete instead, and which means no AIES method statement is ever written.

        I hung this area off `data.methodology` existing, which quietly excluded the second case
        entirely: the sites that insist on their own paperwork are exactly the sites where there is
        no methodology record to hang anything on. Reported by the company on 2026-08-19, one panel
        after I had described it as fixed.

        So it is always here, and it is filed against the **ticket**. Filing against the methodology
        had one thing going for it — a revision is a new methodology, so R1's signed copy would not
        follow R2 around — and that is worth less than being able to attach a document at all. It
        also puts this in step with testing and commissioning and the service report, which both
        file against the ticket for the same reason: the paperwork belongs to the job.

        The entity *type* stays METHODOLOGY_ENTITY_TYPE while the *id* is the ticket's — the same
        pairing TcPanel and ServiceReportPanel use. It is what lets the already-registered file
        access checker apply: an unregistered entity type is refused outright by design, so
        inventing a "Ticket" attachment scope here would have produced an upload area that looked
        right and rejected every file.

        **Uploading does not clear the gate**, and should not. The platform cannot read a PDF and
        know it is an approval; a file with the right name is not a signature. Where a customer's own
        approved form is the whole story, the honest route past the block is "Mobilise anyway" with
        its written reason — a recorded decision by a named person, which is what the gate is
        actually for.
      */}
      <Card className="mt-3 p-3">
        <h3 className="text-sm font-semibold">The client&rsquo;s approval document</h3>
        <p className="mt-1 text-xs text-text-muted">
          Our method statement signed by them, or their own form completed by us — whichever this
          site works to. Attach it whether or not a method statement was written here.
        </p>
        <div className="mt-2">
          <Attachments
            entityType={METHODOLOGY_ENTITY_TYPE}
            entityId={ticketId}
            emptyText="Nothing attached yet. A client approval with no document behind it is somebody's word for it."
          />
        </div>
      </Card>

      {data.blocks && canOverride && <OverrideBlock ticketId={ticketId} onDone={refresh} />}
    </Card>
  );
}

/** §6.2's institutional library is offered here, at the one moment it is useful. */
function CreateForm({
  ticketId,
  projectId,
  defaultTitle,
  onDone,
  onCancel,
}: {
  ticketId: string;
  projectId: string | null;
  defaultTitle: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [cloneFromId, setCloneFromId] = useState("");
  const reusable = trpc.operations.reusableMethodologies.useQuery();
  const create = trpc.operations.createMethodology.useMutation({ onSuccess: onDone });

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <div>
        <Label htmlFor="mth-title">Title</Label>
        <Input id="mth-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div>
        <Label htmlFor="mth-clone">Start from a previous one</Label>
        <Select id="mth-clone" value={cloneFromId} onChange={(e) => setCloneFromId(e.target.value)}>
          <option value="">Start from blank</option>
          {(reusable.data ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.number} R{entry.revision} — {entry.title}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-text-muted">
          {/* Only client-approved ones are offered: a draft somebody abandoned is not a template,
              and cloning a rejected revision would propagate what the customer objected to. */}
          Only method statements a client has approved. This is how the library builds up instead of
          everybody rewriting from scratch.
        </p>
      </div>

      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={create.isPending || title.trim().length === 0}
          onClick={() =>
            create.mutate({ ticketId, projectId, title, cloneFromId: cloneFromId || null })
          }
        >
          Create it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** §6.2: president and VP only, and logged with a reason. */
function OverrideBlock({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const override = trpc.operations.overrideMethodologyGate.useMutation({
    onSuccess: () => {
      setOpen(false);
      setReason("");
      onDone();
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        Mobilise anyway
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm text-amber-900">
        This starts work the client has not approved the method for. If anything goes wrong on site,
        this reason is what AIES has to stand on.
      </p>
      <Textarea
        className="mt-2"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {reason.trim().length < 10 && (
        <p className="mt-1 text-xs text-amber-900">
          {reason.trim().length === 0
            ? "Write the reason before you can override — at least 10 characters."
            : `${10 - reason.trim().length} more character${10 - reason.trim().length === 1 ? "" : "s"} before you can override.`}
        </p>
      )}
      {override.error && <p className="mt-2 text-sm text-danger">{override.error.message}</p>}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={override.isPending || reason.trim().length < 10}
          onClick={() => override.mutate({ ticketId, reason })}
        >
          {override.isPending ? "Overriding…" : "Override the gate"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
