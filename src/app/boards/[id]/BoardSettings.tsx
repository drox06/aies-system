"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  SWIMLANE_LABELS,
  SWIMLANE_OPTIONS,
  type SwimlaneBy,
} from "@/server/core/collab/board-rules";

/**
 * Changing a board, and deleting one (specs/06-collaboration.md §2).
 *
 * ## Why WIP limits are set here rather than guessed
 *
 * §2 asks for them and gives no numbers, because there are none to give: a sensible limit for
 * *In progress* depends on how many people are on the board. A default would be a number the
 * platform invented and everybody then ignored, so a column has no limit until somebody sets one.
 *
 * ## Why deleting says what it will not do
 *
 * "Delete board" reads like it deletes the work on it. It does not — the cards are taken off and the
 * tasks carry on — and the dialog says so, because somebody hesitating over this button is asking
 * exactly that question.
 */
export function BoardSettings({
  boardId,
  name,
  isPrivate,
  swimlaneBy,
  type,
  columns,
  onSaved,
}: {
  boardId: string;
  name: string;
  isPrivate: boolean;
  swimlaneBy: SwimlaneBy;
  type: string;
  columns: { key: string; label: string; wip: { limit: number | null } }[];
  onSaved: () => void;
}) {
  const router = useRouter();
  const [nextName, setNextName] = useState(name);
  const [nextPrivate, setNextPrivate] = useState(isPrivate);
  const [nextLanes, setNextLanes] = useState<SwimlaneBy>(swimlaneBy);
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(columns.map((column) => [column.key, column.wip.limit?.toString() ?? ""])),
  );
  const [confirming, setConfirming] = useState(false);

  const update = trpc.collab.updateBoard.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      onSaved();
    },
    onError: toastError,
  });

  const remove = trpc.collab.deleteBoard.useMutation({
    onSuccess: () => {
      toastSuccess("Board deleted. Its tasks were taken off it, not deleted.");
      router.push("/boards");
    },
    onError: toastError,
  });

  const wipLimits = () => {
    const entries = Object.entries(limits)
      .map(([key, value]) => [key, Number.parseInt(value, 10)] as const)
      .filter(([, value]) => Number.isInteger(value) && value > 0);
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  };

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="board-rename">Name</Label>
          <Input
            id="board-rename"
            value={nextName}
            onChange={(event) => setNextName(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="board-lanes-edit">Rows</Label>
          <Select
            id="board-lanes-edit"
            value={nextLanes}
            onChange={(event) => setNextLanes(event.target.value as SwimlaneBy)}
          >
            {SWIMLANE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {SWIMLANE_LABELS[option]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={nextPrivate}
          onChange={(event) => setNextPrivate(event.target.checked)}
        />
        Private — only you can open it
      </label>

      {type === "manual" && (
        <div>
          <p className="text-sm font-medium">How many at once</p>
          <p className="mt-1 text-xs text-text-muted">
            Leave a column blank for no limit. Going over is allowed and shown in red — the point of
            a limit is to make overload visible, not to stop somebody recording where the work
            actually is.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {columns.map((column) => (
              <div key={column.key}>
                <Label htmlFor={`wip-${column.key}`}>{column.label}</Label>
                <Input
                  id={`wip-${column.key}`}
                  className="w-24"
                  inputMode="numeric"
                  value={limits[column.key] ?? ""}
                  onChange={(event) =>
                    setLimits((was) => ({ ...was, [column.key]: event.target.value }))
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={update.isPending || nextName.trim().length < 2}
          onClick={() =>
            update.mutate({
              boardId,
              name: nextName,
              isPrivate: nextPrivate,
              swimlaneBy: nextLanes,
              ...(type === "manual" ? { wipLimits: wipLimits() } : {}),
            })
          }
        >
          Save
        </Button>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          Delete board
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete "${name}"?`}
        description={
          "The tasks on it are not deleted — they are taken off the board and stay on My Work and " +
          "on the records they belong to. Only this way of looking at them goes."
        }
        confirmLabel="Delete the board"
        destructive
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ boardId })}
      />
    </Card>
  );
}
