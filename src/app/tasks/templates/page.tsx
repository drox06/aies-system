"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  ASSIGN_MODES,
  ASSIGN_MODE_EXPLANATIONS,
  ASSIGN_MODE_LABELS,
  type AssignMode,
} from "@/server/core/collab/task-template-rules";

/**
 * What the platform will do without being asked (specs/06-collaboration.md §2).
 *
 * ## Why this screen is readable by everybody
 *
 * A task appears on somebody's list because a sales order was raised three rooms away. Without a
 * page that says *"when a sales order is raised, finance gets 'raise the downpayment invoice' within
 * a day"*, that task is an instruction from nowhere — and an instruction from nowhere is the thing
 * people stop trusting first.
 *
 * ## What can be changed here, and what cannot
 *
 * §2 asks for the assignment mode to be configurable, so the mode is a dropdown and a whole template
 * can be switched off. The titles, roles and due offsets are not editable: they are the operations
 * flowchart written down, and changing what work exists is a different decision from changing who
 * picks it up. Both changes are audited.
 */
export default function TaskTemplatesPage() {
  const utils = trpc.useUtils();
  const templates = trpc.collab.templates.useQuery();

  const setActive = trpc.collab.setTemplateActive.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      void utils.collab.templates.invalidate();
    },
    onError: toastError,
  });

  const setMode = trpc.collab.setTemplateAssignMode.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      void utils.collab.templates.invalidate();
    },
    onError: toastError,
  });

  const rows = templates.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Task templates"
        description="The standing answers to “who does what when this happens”, instead of a meeting."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/tasks">All tasks</Link>
          </Button>
        }
      />

      <Card className="mb-4 text-sm text-text-muted">
        <p>
          These fire on their own when a record moves. Each line says who it goes to and when it is
          due — <strong className="text-text">working days</strong> throughout, so a task raised at
          five on a Friday and due &ldquo;+1 day&rdquo; is due on Monday.
        </p>
        <dl className="mt-3 space-y-2">
          {ASSIGN_MODES.map((mode) => (
            <div key={mode}>
              <dt className="font-medium text-text">{ASSIGN_MODE_LABELS[mode]}</dt>
              <dd>{ASSIGN_MODE_EXPLANATIONS[mode]}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {templates.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {templates.isError && (
        <Card className="text-sm">
          <p className="font-medium">The templates could not be read.</p>
          <p className="mt-1 text-text-muted">{templates.error.message}</p>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((template) => (
          <Card key={template.id}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{template.name}</h2>
                  {template.isActive ? (
                    <StatusBadge tone="approved">On</StatusBadge>
                  ) : (
                    <StatusBadge tone="cancelled">Off</StatusBadge>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs text-text-muted">
                  {template.trigger}
                  {template.condition
                    ? ` · only when ${Object.entries(template.condition as Record<string, string>)
                        .map(([field, value]) => `${field} is ${value}`)
                        .join(" and ")}`
                    : ""}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {template.raised === 0
                    ? "Has not raised anything yet."
                    : `Has raised ${template.raised} task${template.raised === 1 ? "" : "s"}.`}
                </p>
              </div>

              <Button
                size="sm"
                variant={template.isActive ? "secondary" : "primary"}
                disabled={setActive.isPending}
                onClick={() =>
                  setActive.mutate({ templateId: template.id, isActive: !template.isActive })
                }
              >
                {template.isActive ? "Turn off" : "Turn on"}
              </Button>
            </div>

            <ul className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
              {template.tasks.map((task) => (
                <li key={task.key} className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{task.title}</p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {task.assignTo === "record_owner"
                        ? "To the person the record names, falling back to "
                        : "To "}
                      {task.roleKeys.map((role) => role.replace(/_/g, " ")).join(" or ")}
                      {" · "}
                      {dueText(task.dueInDays, task.dueFrom)}
                      {task.priority && task.priority !== "normal" ? ` · ${task.priority}` : ""}
                    </p>
                    {task.description && (
                      <p className="mt-1 text-xs text-text-muted">{task.description}</p>
                    )}
                  </div>

                  <Select
                    aria-label={`How “${task.title}” assigns`}
                    className="shrink-0"
                    value={task.assignMode}
                    disabled={setMode.isPending}
                    onChange={(event) =>
                      setMode.mutate({
                        templateId: template.id,
                        taskKey: task.key,
                        assignMode: event.target.value as AssignMode,
                      })
                    }
                  >
                    {ASSIGN_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {ASSIGN_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** When a template's task is due, in words a person can check against what they expected. */
function dueText(dueInDays: number | undefined, dueFrom: string | undefined): string {
  const anchor =
    dueFrom === "neededBy"
      ? "the date the money is needed"
      : dueFrom === "liquidationDue"
        ? "the liquidation due date"
        : "the day it fires";

  if (dueInDays === undefined || dueInDays === null) return `due on ${anchor}`;
  if (dueInDays === 0) return `due the same day as ${anchor}`;
  return `due ${dueInDays} working day${dueInDays === 1 ? "" : "s"} after ${anchor}`;
}
