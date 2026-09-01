"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ChannelSettings } from "./ChannelSettings";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  NOTIFICATION_LEVELS,
  NOTIFICATION_LEVEL_LABELS,
  type NotificationLevel,
} from "@/server/core/collab/channel-rules";
import { TASK_ENTITY_HREF, isTaskEntityType } from "@/server/core/collab/task-rules";

/**
 * One channel (specs/06-collaboration.md §3).
 *
 * ## The two things that stop this being a parallel universe
 *
 * **Record links.** A message that names `AIESSO-261561` carries a card that goes to that order, so
 * a conversation about a job can be got back to *from the job*. **Promote to task.** Any message
 * becomes an owned, dated item in one action — which is how "can someone check the Cebu delivery"
 * stops scrolling away. §1's complaint is work agreed and never written down; a chat window is just
 * a faster way to do that, unless these two seams exist.
 *
 * ## Archived means readable, not editable
 *
 * A closed project's channel is part of that project's record. The composer is replaced by a line
 * saying so, rather than a box that refuses on submit.
 */
const REACTIONS = ["👍", "✅", "👀", "🙏", "❓"];

export default function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();
  const [body, setBody] = useState("");
  const [thread, setThread] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<{ id: string; body: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /*
    Whether to offer the settings button at all.

    Asked rather than assumed: a button that 403s teaches somebody the platform is unreliable, when
    the truth is only that the job is not theirs. The server gates it regardless.
  */
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManage = me.data?.permissions.includes("channel.manage") ?? false;

  const view = trpc.collab.channel.useQuery({ channelId: id, threadRootId: thread });
  const markRead = trpc.collab.markChannelRead.useMutation();

  // Opening a channel is reading it. Kept out of the render path so it fires once per visit.
  useEffect(() => {
    markRead.mutate({ channelId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const refresh = () => {
    void utils.collab.channel.invalidate({ channelId: id });
    void utils.collab.channels.invalidate();
  };

  const post = trpc.collab.postMessage.useMutation({
    onSuccess: () => {
      setBody("");
      refresh();
    },
    onError: toastError,
  });

  const react = trpc.collab.react.useMutation({ onSuccess: refresh, onError: toastError });
  const remove = trpc.collab.deleteMessage.useMutation({
    onSuccess: () => {
      toastSuccess("Withdrawn.");
      refresh();
    },
    onError: toastError,
  });

  const setLevel = trpc.collab.setChannelNotifications.useMutation({
    onSuccess: () => toastSuccess("Saved."),
    onError: toastError,
  });

  if (view.isLoading) return <Card className="text-sm text-text-muted">Loading…</Card>;

  if (view.isError) {
    return (
      <Card className="text-sm">
        <p className="font-medium">This discussion could not be opened.</p>
        <p className="mt-1 text-text-muted">{view.error.message}</p>
        <Button className="mt-3" variant="secondary" asChild>
          <Link href="/channels">Back to Discussion</Link>
        </Button>
      </Card>
    );
  }

  const { channel, messages } = view.data!;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={channel.name}
        description={channel.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {channel.entityType && channel.entityId && isTaskEntityType(channel.entityType) && (
              <Button variant="secondary" size="sm" asChild>
                <Link href={TASK_ENTITY_HREF[channel.entityType](channel.entityId)}>
                  Open the {channel.entityType.replace(/([a-z])([A-Z])/g, "$1 $2")}
                </Link>
              </Button>
            )}
            {channel.isMember && !channel.archivedAt && (
              <Select
                aria-label="Tell me about"
                className="h-9 text-sm"
                defaultValue="all"
                onChange={(event) =>
                  setLevel.mutate({
                    channelId: id,
                    level: event.target.value as NotificationLevel,
                  })
                }
              >
                {NOTIFICATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {NOTIFICATION_LEVEL_LABELS[level]}
                  </option>
                ))}
              </Select>
            )}
            {canManage && (
              <Button variant="secondary" size="sm" onClick={() => setSettingsOpen((was) => !was)}>
                {settingsOpen ? "Close settings" : "Settings"}
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link href="/channels">All discussions</Link>
            </Button>
          </div>
        }
      />

      {settingsOpen && canManage && (
        <ChannelSettings
          channelId={channel.id}
          name={channel.name}
          description={channel.description}
          archived={!!channel.archivedAt}
          onSaved={() => {
            setSettingsOpen(false);
            refresh();
          }}
        />
      )}

      {channel.archivedAt && (
        <Card className="mb-4 text-sm">
          <StatusBadge tone="cancelled">Archived</StatusBadge>
          <p className="mt-2">
            This discussion closed with its job and is kept as part of that record. It can be read
            and not added to.
          </p>
        </Card>
      )}

      {thread && (
        <Card className="mb-4 flex items-center justify-between gap-3 text-sm">
          <span>Showing one thread.</span>
          <Button variant="secondary" size="sm" onClick={() => setThread(null)}>
            Back to the discussion
          </Button>
        </Card>
      )}

      {messages.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing said here yet."
            description="Mention a document number — AIESSO-261561 — and it will link itself to the record."
          />
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((message) => (
          <Card key={message.id}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{message.authorName}</span>
              <DateCell value={message.createdAt} withTime className="text-xs text-text-muted" />
              {message.editedAt && <span className="text-xs text-text-muted">edited</span>}
              {message.mentionedHere && <StatusBadge tone="pending">@here</StatusBadge>}
            </div>

            <p className="mt-1 whitespace-pre-wrap">{message.body}</p>

            {message.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.links.map((link) => (
                  <Link
                    key={`${link.entityType}-${link.entityId}`}
                    href={
                      isTaskEntityType(link.entityType)
                        ? TASK_ENTITY_HREF[link.entityType](link.entityId)
                        : "#"
                    }
                    className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs hover:bg-surface"
                  >
                    <span className="text-text-muted">{link.label} </span>
                    <span className="tabular">{link.number}</span>
                  </Link>
                ))}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {Object.entries(message.reactions).map(([emoji, people]) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
                  onClick={() => react.mutate({ messageId: message.id, emoji })}
                >
                  {emoji} {people.length}
                </button>
              ))}
              {!channel.archivedAt &&
                REACTIONS.filter((emoji) => !message.reactions[emoji]).map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`React ${emoji}`}
                    className="rounded-full border border-transparent px-1.5 py-0.5 text-xs opacity-40 hover:opacity-100"
                    onClick={() => react.mutate({ messageId: message.id, emoji })}
                  >
                    {emoji}
                  </button>
                ))}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {!thread && (
                <button
                  type="button"
                  className="text-blue-600 underline-offset-4 hover:underline"
                  onClick={() => setThread(message.id)}
                >
                  {message.replyCount > 0
                    ? `${message.replyCount} repl${message.replyCount === 1 ? "y" : "ies"}`
                    : "Reply in a thread"}
                </button>
              )}
              {!channel.archivedAt && (
                <button
                  type="button"
                  className="text-blue-600 underline-offset-4 hover:underline"
                  onClick={() => setPromoting({ id: message.id, body: message.body })}
                >
                  Make it a task
                </button>
              )}
              {message.canEdit && (
                <button
                  type="button"
                  className="text-text-muted underline-offset-4 hover:underline"
                  onClick={() => remove.mutate({ messageId: message.id })}
                >
                  Withdraw
                </button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {promoting && (
        <PromoteToTask
          message={promoting}
          onDone={() => {
            setPromoting(null);
            refresh();
          }}
          onCancel={() => setPromoting(null)}
        />
      )}

      {channel.canPost ? (
        <Card className="mt-4">
          <Label htmlFor="composer">
            {thread ? "Reply in this thread" : `Say something in ${channel.name}`}
          </Label>
          <Textarea
            id="composer"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Name somebody with @, or a document number to link it"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              disabled={post.isPending || body.trim().length === 0}
              onClick={() =>
                post.mutate({ channelId: id, body, threadRootId: thread ?? undefined })
              }
            >
              Post
            </Button>
            <span className="text-xs text-text-muted">
              Fifteen minutes to edit or withdraw, then it stands.
            </span>
          </div>
        </Card>
      ) : (
        !channel.archivedAt && (
          <Card className="mt-4 text-sm text-text-muted">
            You are reading a discussion you are not in. Join it from the Discussion list to post.
          </Card>
        )
      )}
    </div>
  );
}

/**
 * §3's promote-to-task, as a form.
 *
 * The title is asked for rather than taken from the message, deliberately: *"can someone check the
 * Cebu delivery"* is a question, and a task list of questions is a list nobody can work from. What
 * was said travels into the description, so nothing is lost.
 */
function PromoteToTask({
  message,
  onDone,
  onCancel,
}: {
  message: { id: string; body: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(message.body.slice(0, 100));
  const [assigneeId, setAssigneeId] = useState("");
  const [dueAt, setDueAt] = useState("");

  const people = trpc.collab.assignableUsers.useQuery();
  const promote = trpc.collab.promoteMessage.useMutation({
    onSuccess: (task) => {
      toastSuccess(`Raised ${task.number}.`);
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mt-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="promote-title">What needs doing</Label>
        <Input
          id="promote-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          The message itself goes into the task, with who said it and where.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="promote-assignee">Whose</Label>
          <Select
            id="promote-assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Mine</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="promote-due">Due</Label>
          <Input
            id="promote-due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          disabled={promote.isPending || title.trim().length < 3}
          onClick={() =>
            promote.mutate({
              messageId: message.id,
              title,
              assigneeId: assigneeId || null,
              dueAt: dueAt ? new Date(dueAt) : null,
            })
          }
        >
          Raise it
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
