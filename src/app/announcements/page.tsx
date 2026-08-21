"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §5's announcements, and the acknowledgement that is the actual point.
 *
 * ## Why the tick matters more than the notice
 *
 * This is ISO 9001 clause 7.4 evidence. A revised procedure nobody can prove was read is a revised
 * procedure that did not happen — and the first time somebody asks *"who has seen this?"* is the
 * first time a compliance list earns its place. What this screen is built around is therefore the
 * **outstanding** list, not the published one.
 *
 * ## Expired notices keep their acknowledgements
 *
 * Expiry hides a notice from the current list and changes nothing else. Clause 7.4 asks who was
 * told, not who is still being told.
 */
const ROLE_OPTIONS = [
  { key: "president", label: "President" },
  { key: "vice_president", label: "Vice President" },
  { key: "operations_manager", label: "Operations Manager" },
  { key: "admin_manager", label: "Admin Manager" },
  { key: "marketing_manager", label: "Sales and Marketing Manager" },
  { key: "sales", label: "Sales" },
  { key: "finance_officer", label: "Finance Officer" },
  { key: "technician", label: "Technician" },
];

export default function AnnouncementsPage() {
  const utils = trpc.useUtils();
  const announcements = trpc.collab.announcements.useQuery();
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canPublish = me.data?.permissions.includes("announcement.publish") ?? false;

  const [publishing, setPublishing] = useState(false);
  const [showing, setShowing] = useState<string | null>(null);

  const acknowledge = trpc.collab.acknowledgeAnnouncement.useMutation({
    onSuccess: () => {
      toastSuccess("Recorded. Thank you.");
      void utils.collab.announcements.invalidate();
    },
    onError: toastError,
  });

  const rows = announcements.data?.rows ?? [];
  const current = rows.filter((row) => row.current);
  const past = rows.filter((row) => !row.current);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Announcements"
        description="What the company has told everybody, and who has confirmed reading it."
        actions={
          canPublish && (
            <Button variant="secondary" onClick={() => setPublishing((was) => !was)}>
              {publishing ? "Close" : "Publish"}
            </Button>
          )
        }
      />

      {publishing && canPublish && (
        <Publish
          onDone={() => {
            setPublishing(false);
            void utils.collab.announcements.invalidate();
          }}
        />
      )}

      {(announcements.data?.awaitingMe ?? 0) > 0 && (
        <Card className="mb-4">
          <StatusBadge tone="pending">{announcements.data!.awaitingMe} waiting on you</StatusBadge>
          <p className="mt-2 text-sm">
            These ask you to confirm you have read them. The confirmation is kept as the
            company&rsquo;s record that you were told.
          </p>
        </Card>
      )}

      {announcements.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {rows.length === 0 && !announcements.isLoading && (
        <Card>
          <EmptyState
            title="Nothing has been announced."
            description="Policy changes, safety bulletins and revised procedures appear here."
          />
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {current.map((row) => (
          <Card key={row.id}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">{row.title}</h2>
              {row.priority === "urgent" && <StatusBadge tone="failed">Urgent</StatusBadge>}
              {row.requiresAck &&
                (row.acknowledgedAt ? (
                  <StatusBadge tone="approved">You confirmed</StatusBadge>
                ) : (
                  <StatusBadge tone="pending">Needs your confirmation</StatusBadge>
                ))}
              {row.audienceRoleKeys.length > 0 && (
                <StatusBadge tone="draft">
                  {row.audienceRoleKeys.map((key) => key.replace(/_/g, " ")).join(", ")}
                </StatusBadge>
              )}
            </div>

            <p className="mt-2 text-sm whitespace-pre-wrap">{row.body}</p>

            <p className="mt-2 text-xs text-text-muted">
              {row.publishedByName} · <DateCell value={row.publishedAt} withTime />
              {row.expiresAt && (
                <>
                  {" · until "}
                  <DateCell value={row.expiresAt} />
                </>
              )}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {row.requiresAck && !row.acknowledgedAt && (
                <Button
                  size="sm"
                  disabled={acknowledge.isPending}
                  onClick={() => acknowledge.mutate({ announcementId: row.id })}
                >
                  I have read this
                </Button>
              )}
              {row.acknowledgedAt && (
                <span className="text-xs text-text-muted">
                  Confirmed <DateCell value={row.acknowledgedAt} withTime />
                </span>
              )}
              {canPublish && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowing(showing === row.id ? null : row.id)}
                >
                  {showing === row.id ? "Hide who has read it" : "Who has read it"}
                </Button>
              )}
            </div>

            {showing === row.id && canPublish && <Compliance announcementId={row.id} />}
          </Card>
        ))}
      </div>

      {past.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium">Expired</h2>
          <p className="mb-2 text-sm text-text-muted">
            Off the current list. The confirmations are kept — what the company can prove does not
            expire with the notice.
          </p>
          <div className="flex flex-col gap-2">
            {past.map((row) => (
              <Card key={row.id} className="text-sm">
                <span className="font-medium">{row.title}</span>
                <span className="text-text-muted">
                  {" · "}
                  <DateCell value={row.publishedAt} />
                </span>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** §5's compliance list — outstanding first, because it exists to be acted on. */
function Compliance({ announcementId }: { announcementId: string }) {
  const list = trpc.collab.acknowledgements.useQuery({ announcementId });

  if (list.isLoading) return <p className="mt-2 text-xs text-text-muted">Looking…</p>;
  if (!list.data) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-sm">
        {list.data.outstanding === 0 ? (
          <span>Everybody addressed has confirmed.</span>
        ) : (
          <span>
            <strong>{list.data.outstanding}</strong> of {list.data.people.length} have not
            confirmed.
          </span>
        )}
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {list.data.people.map((person) => (
          <li key={person.userId} className="flex flex-wrap items-center gap-2">
            {person.acknowledgedAt ? (
              <StatusBadge tone="approved">Read</StatusBadge>
            ) : (
              <StatusBadge tone="pending">Not yet</StatusBadge>
            )}
            <span>{person.name}</span>
            {person.acknowledgedAt && (
              <DateCell
                value={person.acknowledgedAt}
                withTime
                className="text-xs text-text-muted"
              />
            )}
          </li>
        ))}
      </ul>
      {list.data.acknowledgedByOthers > 0 && (
        <p className="mt-2 text-xs text-text-muted">
          {list.data.acknowledgedByOthers} more confirmed it and are no longer in this audience —
          they read it, and that still counts.
        </p>
      )}
    </div>
  );
}

function Publish({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [requiresAck, setRequiresAck] = useState(true);
  const [priority, setPriority] = useState<"low" | "normal" | "urgent">("normal");
  const [expiresAt, setExpiresAt] = useState("");

  const publish = trpc.collab.publishAnnouncement.useMutation({
    onSuccess: () => {
      toastSuccess("Published.");
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="ann-title">Headline</Label>
        <Input
          id="ann-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Revised lifting procedure, effective Monday"
        />
      </div>

      <div>
        <Label htmlFor="ann-body">What changed, and what people must do</Label>
        <Textarea
          id="ann-body"
          rows={5}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          This is the text somebody will be shown later as proof of what they confirmed reading, so
          it has to stand on its own.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="ann-audience">Who it is for</Label>
          <Select
            id="ann-audience"
            multiple
            className="h-28"
            value={roleKeys}
            onChange={(event) =>
              setRoleKeys([...event.target.selectedOptions].map((option) => option.value))
            }
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role.key} value={role.key}>
                {role.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-text-muted">Select none for the whole company.</p>
        </div>
        <div>
          <Label htmlFor="ann-priority">Priority</Label>
          <Select
            id="ann-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as "low" | "normal" | "urgent")}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="ann-expires">Off the list after (optional)</Label>
          <Input
            id="ann-expires"
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={requiresAck}
          onChange={(event) => setRequiresAck(event.target.checked)}
        />
        People must confirm they have read it
      </label>

      <div className="flex items-center gap-2">
        <Button
          disabled={publish.isPending || title.trim().length < 4 || body.trim().length < 20}
          onClick={() =>
            publish.mutate({
              title,
              body,
              audienceRoleKeys: roleKeys,
              requiresAck,
              priority,
              expiresAt: expiresAt ? new Date(expiresAt) : null,
            })
          }
        >
          Publish it
        </Button>
        <span className="text-xs text-text-muted">Everybody addressed is notified at once.</span>
      </div>
    </Card>
  );
}
