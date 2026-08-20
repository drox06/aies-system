"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * A new checklist template — the one thing this screen could not do.
 *
 * ## Why this was a gap and not dead code
 *
 * It nearly went the other way. `createChecklistTemplate` had no caller and the screen already had
 * `saveChecklistDraft`, so it looked superseded — until `saveDraftService` turned out to require an
 * existing `templateId`. It only **edits**. So the eleven seeded templates could be revised and
 * published forever and a twelfth could never exist.
 *
 * Worth recording as a triage lesson: "there is a similar procedure that is wired" is not evidence
 * that the unwired one is redundant. The two did different halves of the job.
 *
 * ## The key is permanent and the name is not
 *
 * `key` is what a checklist response cites as the procedure it followed, and what
 * `activeTemplateService` looks up when a ticket starts one. Renaming a template is ordinary;
 * changing its key would orphan every response that ever named it. So the key is set once, here,
 * and the form says so rather than letting somebody discover it later.
 */
export function NewChecklist({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [stage, setStage] = useState("");
  const [description, setDescription] = useState("");

  const create = trpc.operations.createChecklistTemplate.useMutation({
    onSuccess: () => {
      toastSuccess(`${name} created as a draft. Add its sections, then publish it.`);
      setOpen(false);
      setKey("");
      setName("");
      setStage("");
      setDescription("");
      onCreated();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button size="sm" className="mb-3" onClick={() => setOpen(true)}>
        New checklist
      </Button>
    );
  }

  const canSubmit = key.trim().length > 0 && name.trim().length > 0 && stage.trim().length > 0;

  return (
    <Card className="mb-4 p-4">
      <h2 className="text-sm font-semibold">New checklist</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Created as a draft with no sections. Add them, then publish — a published version becomes
        the procedure of record and cannot be rewritten.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="nc-name">What it is called</Label>
          <Input
            id="nc-name"
            value={name}
            placeholder="Pre-mobilisation safety check"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">Can be changed later.</p>
        </div>

        <div>
          <Label htmlFor="nc-key">Key</Label>
          <Input
            id="nc-key"
            value={key}
            placeholder="pre_mobilisation_safety"
            onChange={(event) => setKey(event.target.value)}
          />
          {/*
            The one field that is permanent. A response cites the key as the procedure it followed,
            and a ticket looks a checklist up by it — changing it would orphan every response that
            ever named it. Said now rather than discovered later.
          */}
          <p className="mt-1 text-xs text-amber-700">
            Set once and never changed. Completed checklists cite it as the procedure they followed.
          </p>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="nc-stage">When it is used</Label>
          <Input
            id="nc-stage"
            value={stage}
            placeholder="mobilisation"
            onChange={(event) => setStage(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            The point in a job this belongs to, so it is offered where it is needed rather than in a
            list of everything.
          </p>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="nc-desc">What it is for</Label>
          <Textarea
            id="nc-desc"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || create.isPending}
          onClick={() =>
            create.mutate({
              key: key.trim(),
              name: name.trim(),
              stage: stage.trim(),
              description: description.trim() === "" ? null : description.trim(),
            })
          }
        >
          {create.isPending ? "Creating…" : "Create it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
