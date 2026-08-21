"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  CHANNEL_TYPES,
  CHANNEL_TYPE_LABELS,
  type ChannelType,
} from "@/server/core/collab/channel-rules";

/**
 * §3's channel list.
 *
 * ## Archived channels stay on the list
 *
 * When a project closes its channel archives read-only and is *"retained as part of the project
 * record"*. A record that disappears from every list is a record nobody will find again, so it stays
 * here, marked, below the live ones.
 *
 * ## Unread is counted, not guessed
 *
 * Somebody who has never opened a channel has read **nothing** in it rather than everything. The
 * opposite default would hide the conversation that was going on before they were added — which is
 * usually the conversation they were added for.
 */
export default function ChannelsPage() {
  const utils = trpc.useUtils();
  const channels = trpc.collab.channels.useQuery();
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");

  const search = trpc.collab.searchMessages.useQuery(
    { query },
    { enabled: query.trim().length >= 2 },
  );

  const join = trpc.collab.joinChannel.useMutation({
    onSuccess: () => {
      toastSuccess("Joined.");
      void utils.collab.channels.invalidate();
    },
    onError: toastError,
  });

  const live = (channels.data ?? []).filter((channel) => !channel.archivedAt);
  const archived = (channels.data ?? []).filter((channel) => channel.archivedAt);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Channels"
        description="Conversation that leaves a record, next to the records it is about."
        actions={
          <Button variant="secondary" onClick={() => setOpening((was) => !was)}>
            {opening ? "Close" : "New channel"}
          </Button>
        }
      />

      {opening && (
        <NewChannel
          onDone={() => {
            setOpening(false);
            void utils.collab.channels.invalidate();
          }}
        />
      )}

      <Card className="mb-4">
        <Label htmlFor="message-search">Search what has been said</Label>
        <Input
          id="message-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A word, a number, a name"
        />
        {query.trim().length >= 2 && (
          <div className="mt-3">
            {search.isLoading && <p className="text-sm text-text-muted">Looking…</p>}
            {search.data?.length === 0 && (
              <p className="text-sm text-text-muted">
                Nothing in any channel you can read. Private channels you are not in are not
                searched.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {(search.data ?? []).map((hit) => (
                <li key={hit.id} className="text-sm">
                  <Link
                    href={`/channels/${hit.channelId}`}
                    className="text-blue-600 underline-offset-4 hover:underline"
                  >
                    {hit.channelName}
                  </Link>
                  <span className="text-text-muted">
                    {" · "}
                    {hit.authorName}
                    {" · "}
                  </span>
                  <DateCell value={hit.createdAt} withTime className="text-text-muted" />
                  <p className="mt-0.5">{hit.body.slice(0, 240)}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {channels.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {channels.isError && (
        <Card className="text-sm">
          <p className="font-medium">The channels could not be read.</p>
          <p className="mt-1 text-text-muted">{channels.error.message}</p>
        </Card>
      )}

      {channels.data?.length === 0 && (
        <Card>
          <EmptyState
            title="No channels yet."
            description="Project channels open on their own when work starts. Anything else, open one."
          />
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {live.map((channel) => (
          <Card key={channel.id} className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/channels/${channel.id}`} className="font-medium hover:underline">
                  {channel.name}
                </Link>
                <StatusBadge tone="draft">
                  {CHANNEL_TYPE_LABELS[channel.type as ChannelType] ?? channel.type}
                </StatusBadge>
                {channel.isPrivate && <StatusBadge tone="cancelled">Private</StatusBadge>}
                {channel.unread > 0 && (
                  <StatusBadge tone="info">
                    {channel.unread >= 100 ? "99+" : channel.unread} unread
                  </StatusBadge>
                )}
              </div>
              {channel.description && (
                <p className="mt-1 text-sm text-text-muted">{channel.description}</p>
              )}
              <p className="mt-1 text-xs text-text-muted">
                {channel.memberCount} member{channel.memberCount === 1 ? "" : "s"}
                {channel.lastMessageAt ? " · last said " : " · nothing said yet"}
                {channel.lastMessageAt && <DateCell value={channel.lastMessageAt} withTime />}
              </p>
            </div>
            {channel.isMember ? (
              <Button variant="secondary" size="sm" asChild>
                <Link href={`/channels/${channel.id}`}>Open</Link>
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={join.isPending}
                onClick={() => join.mutate({ channelId: channel.id })}
              >
                Join
              </Button>
            )}
          </Card>
        ))}
      </div>

      {archived.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium">Archived</h2>
          <p className="mb-2 text-sm text-text-muted">
            Kept as part of the record of the job they belong to. Readable, not writable.
          </p>
          <div className="flex flex-col gap-2">
            {archived.map((channel) => (
              <Card key={channel.id} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/channels/${channel.id}`} className="hover:underline">
                    {channel.name}
                  </Link>
                  <p className="mt-1 text-xs text-text-muted">
                    Archived <DateCell value={channel.archivedAt} />
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function NewChannel({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ChannelType>("topic");
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const people = trpc.collab.assignableUsers.useQuery();
  const create = trpc.collab.createChannel.useMutation({
    onSuccess: () => {
      toastSuccess("Channel opened.");
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="channel-name">Name</Label>
          <Input
            id="channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Cebu deliveries"
          />
        </div>
        <div>
          <Label htmlFor="channel-type">Kind</Label>
          <Select
            id="channel-type"
            value={type}
            onChange={(event) => setType(event.target.value as ChannelType)}
          >
            {CHANNEL_TYPES.filter((value) => value !== "project" && value !== "direct").map(
              (value) => (
                <option key={value} value={value}>
                  {CHANNEL_TYPE_LABELS[value]}
                </option>
              ),
            )}
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="channel-description">What it is for (optional)</Label>
        <Input
          id="channel-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
        />
        Private — only the people below can read it
      </label>

      {isPrivate && (
        <div>
          <Label htmlFor="channel-members">Who is in it</Label>
          <Select
            id="channel-members"
            multiple
            className="h-32"
            value={memberIds}
            onChange={(event) =>
              setMemberIds([...event.target.selectedOptions].map((option) => option.value))
            }
          >
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-text-muted">
            You are always in a channel you open, whether or not you are on this list.
          </p>
        </div>
      )}

      <div>
        <Button
          disabled={create.isPending || name.trim().length < 2}
          onClick={() =>
            create.mutate({
              name,
              description: description.trim() || null,
              type,
              isPrivate,
              memberIds,
            })
          }
        >
          Open it
        </Button>
      </div>
    </Card>
  );
}
