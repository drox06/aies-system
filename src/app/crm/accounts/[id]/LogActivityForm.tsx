"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

const TYPES = ["call", "meeting", "site_visit", "email", "note", "demo"] as const;

/**
 * Logging a call, meeting or site visit against an account.
 *
 * Collapsed until asked for, and three fields when open. §1 says AIES "generates inquiries through
 * networking and customer relations", which makes this the most frequently used write in the whole
 * module — and a form that takes a minute to fill in is one that gets skipped after the third call
 * of the day, at which point the "not contacted in 60 days" list starts lying.
 *
 * The date defaults to today but is editable, because people log Friday's visit on Monday.
 */
export function LogActivityForm({
  accountId,
  onLogged,
}: {
  accountId: string;
  onLogged: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("call");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [outcome, setOutcome] = useState("");

  const log = trpc.crm.logActivity.useMutation({
    onSuccess: () => {
      void utils.crm.listActivities.invalidate({
        entityType: "CustomerAccount",
        entityId: accountId,
      });
      void utils.crm.myDay.invalidate();
      onLogged();
    },
  });

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(true)}>
        Log contact
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr_9rem]">
        <div>
          <Label htmlFor="act-type">Type</Label>
          <Select
            id="act-type"
            value={type}
            onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="act-subject">What happened *</Label>
          <Input
            id="act-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Called about the flow meter retrofit"
          />
        </div>
        <div>
          <Label htmlFor="act-date">When</Label>
          <Input
            id="act-date"
            type="date"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="act-body">Notes</Label>
        <Textarea id="act-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      <div>
        <Label htmlFor="act-outcome">Outcome</Label>
        <Input
          id="act-outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder="Sending a budgetary quote this week"
        />
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={log.isPending || subject.trim().length === 0}
          onClick={async () => {
            try {
              await log.mutateAsync({
                entityType: "CustomerAccount",
                entityId: accountId,
                type,
                subject,
                body: body || null,
                outcome: outcome || null,
                occurredAt: occurredAt ? new Date(occurredAt) : null,
              });
              toastSuccess("Logged.");
              setSubject("");
              setBody("");
              setOutcome("");
              setOpen(false);
            } catch (error) {
              toastError(error);
            }
          }}
        >
          {log.isPending ? "Saving…" : "Log it"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
