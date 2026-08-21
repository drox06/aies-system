"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Renaming a channel, changing who is in it, and archiving one by hand (§3).
 *
 * ## Why archiving asks twice
 *
 * An archive is permanent for the conversation: nothing further can be posted, by anybody, ever. It
 * is the right thing when a job is done and the discussion is evidence, and the wrong thing when
 * somebody meant to tidy the list. So it asks, and it says which of the two it is about to do.
 *
 * A hand-archived channel **can** be reopened, unlike one archived because its project closed. The
 * first is a judgement about whether a conversation is finished; the second is a fact.
 */
export function ChannelSettings({
  channelId,
  name,
  description,
  archived,
  onSaved,
}: {
  channelId: string;
  name: string;
  description: string | null;
  archived: boolean;
  onSaved: () => void;
}) {
  const [nextName, setNextName] = useState(name);
  const [nextDescription, setNextDescription] = useState(description ?? "");
  const [addIds, setAddIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  const people = trpc.collab.assignableUsers.useQuery();
  const update = trpc.collab.updateChannel.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      setAddIds([]);
      onSaved();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="channel-rename">Name</Label>
          <Input
            id="channel-rename"
            value={nextName}
            onChange={(event) => setNextName(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="channel-redescribe">What it is for</Label>
          <Input
            id="channel-redescribe"
            value={nextDescription}
            onChange={(event) => setNextDescription(event.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="channel-add">Add people</Label>
        <Select
          id="channel-add"
          multiple
          className="h-28"
          value={addIds}
          onChange={(event) =>
            setAddIds([...event.target.selectedOptions].map((option) => option.value))
          }
        >
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={update.isPending || nextName.trim().length < 2}
          onClick={() =>
            update.mutate({
              channelId,
              name: nextName,
              description: nextDescription.trim() || null,
              addMemberIds: addIds,
            })
          }
        >
          Save
        </Button>

        {archived ? (
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ channelId, archived: false })}
          >
            Reopen it
          </Button>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            Archive it
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Archive "${name}"?`}
        description={
          "Nothing more can be posted here by anybody. Everything said stays readable and " +
          "searchable — that is the point of archiving rather than deleting. It can be reopened."
        }
        confirmLabel="Archive it"
        destructive
        isPending={update.isPending}
        onConfirm={() => update.mutate({ channelId, archived: true })}
      />
    </Card>
  );
}
