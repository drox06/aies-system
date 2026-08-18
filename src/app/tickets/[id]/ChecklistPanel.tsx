"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  CHECKLIST_RESPONSE_ENTITY_TYPE,
  allowsNotApplicable,
  checkResponse,
  isFailure,
  type AnswerValue,
  type Answers,
  type ChecklistItem,
} from "@/server/core/operations/checklist-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §15's checklists, on the ticket.
 *
 * The screen's job beyond capture is to make §15's conditional logic visible *while it can still be
 * acted on*: a failure reveals its cause and action immediately, rather than being refused at
 * sign-off when the technician has already left site. The same `checkResponse` runs here and at the
 * service, so the reason for a block is identical in both places.
 *
 * "Not applicable" is offered only where the template said it was available. That is the whole point
 * of §15 having two pass/fail types, and a screen that showed the option everywhere would undo it.
 */

const TONE: Record<string, StatusTone> = { draft: "pending", complete: "approved" };

export function ChecklistPanel({ ticketId }: { ticketId: string }) {
  const rows = trpc.operations.listChecklistsForTicket.useQuery({ ticketId });
  const templates = trpc.operations.listChecklistTemplates.useQuery();
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  const canFill = (me.data?.permissions ?? []).includes("checklist.fill");
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState("");

  const start = trpc.operations.startChecklist.useMutation({
    onSuccess: (created) => {
      setOpenId(created.id);
      void rows.refetch();
    },
  });

  if (rows.isPending) return null;

  const active = (templates.data ?? []).filter((template) => template.status === "active");

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Checklists</h2>
      <p className="mt-1 text-xs text-text-muted">
        §15&rsquo;s record of what was actually checked, against the version of the procedure that
        was in force when it was checked.
      </p>

      {rows.data?.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">Nothing filled in for this ticket yet.</p>
      )}

      {(rows.data ?? []).length > 0 && (
        <ul className="mt-3 space-y-2">
          {(rows.data ?? []).map((row) => (
            <li key={row.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <button
                  type="button"
                  className="text-sm font-medium hover:underline"
                  onClick={() => setOpenId(openId === row.id ? null : row.id)}
                >
                  {row.templateKey} v{row.templateVersion}
                </button>
                <StatusBadge tone={TONE[row.status] ?? "pending"}>
                  {row.status === "complete" ? "Signed off" : "In progress"}
                </StatusBadge>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {row.summary}
                {row.completedAt && (
                  <>
                    {" · "}
                    <DateCell value={row.completedAt} />
                    {row.signedByName ? ` · ${row.signedByName}` : ""}
                  </>
                )}
              </p>

              {openId === row.id && (
                <ResponseForm responseId={row.id} onSaved={() => void rows.refetch()} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canFill && active.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="w-64">
            <Label htmlFor="checklist-start">Start a checklist</Label>
            <Select
              id="checklist-start"
              value={starting}
              onChange={(event) => setStarting(event.target.value)}
            >
              <option value="">Choose one…</option>
              {active.map((template) => (
                <option key={template.id} value={template.key}>
                  {template.name} (v{template.version})
                </option>
              ))}
            </Select>
          </div>
          <Button
            disabled={!starting || start.isPending}
            onClick={() => start.mutate({ templateKey: starting, ticketId })}
          >
            Start
          </Button>
        </div>
      )}

      {start.error && <p className="mt-2 text-sm text-danger">{start.error.message}</p>}
    </Card>
  );
}

function ResponseForm({ responseId, onSaved }: { responseId: string; onSaved: () => void }) {
  const response = trpc.operations.getChecklistResponse.useQuery({ responseId });
  const utils = trpc.useUtils();

  const [draft, setDraft] = useState<Answers | null>(null);
  const [signedByName, setSignedByName] = useState("");

  const save = trpc.operations.saveChecklistAnswers.useMutation({
    onSuccess: () => {
      void utils.operations.getChecklistResponse.invalidate({ responseId });
      onSaved();
    },
  });
  const complete = trpc.operations.completeChecklist.useMutation({
    onSuccess: () => {
      void utils.operations.getChecklistResponse.invalidate({ responseId });
      onSaved();
    },
  });

  if (response.isPending || !response.data) return null;

  const data = response.data;
  const answers = draft ?? (data.answers as Answers);
  const done = data.status === "complete";
  const check = checkResponse(data.sections, answers);

  const setAnswer = (key: string, patch: Partial<AnswerValue>) =>
    setDraft({ ...answers, [key]: { ...answers[key], ...patch } });

  return (
    <div className="mt-3 border-t border-border pt-3">
      {data.sections.map((section) => (
        <div key={section.key} className="mb-4">
          <h3 className="text-sm font-semibold">{section.title}</h3>
          <ul className="mt-2 space-y-3">
            {section.items.map((item) => (
              <li key={item.key}>
                <ItemField
                  item={item}
                  answer={answers[item.key]}
                  disabled={done}
                  onChange={(patch) => setAnswer(item.key, patch)}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* Photographs and the signature live with the response, so evidence travels with the record. */}
      <Attachments
        entityType={CHECKLIST_RESPONSE_ENTITY_TYPE}
        entityId={responseId}
        label="Photographs and signature"
        category="operations"
        canUpload={!done}
      />

      {!done && (
        <>
          {check.invalidNotApplicable.length +
            check.unanswered.length +
            check.incompleteFailures.length >
            0 && (
            <ul className="mt-3 space-y-1 text-sm text-danger">
              {[
                ...check.invalidNotApplicable,
                ...check.unanswered,
                ...check.incompleteFailures,
              ].map((problem) => (
                <li key={`${problem.itemKey}-${problem.reason}`}>
                  <span className="font-medium">{problem.label}</span> — {problem.reason}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="w-48">
              <Label htmlFor={`sig-${responseId}`}>Signed off by</Label>
              <Input
                id={`sig-${responseId}`}
                value={signedByName}
                onChange={(event) => setSignedByName(event.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ responseId, answers: answers as Record<string, unknown> })
              }
            >
              Save progress
            </Button>
            <Button
              disabled={!check.ok || complete.isPending || !signedByName.trim()}
              onClick={async () => {
                await save.mutateAsync({ responseId, answers: answers as Record<string, unknown> });
                complete.mutate({ responseId, signedByName });
              }}
            >
              Sign off
            </Button>
          </div>
        </>
      )}

      {(save.error ?? complete.error) && (
        <p className="mt-2 text-sm text-danger">{(save.error ?? complete.error)!.message}</p>
      )}
    </div>
  );
}

function ItemField({
  item,
  answer,
  disabled,
  onChange,
}: {
  item: ChecklistItem;
  answer: AnswerValue | undefined;
  disabled: boolean;
  onChange: (patch: Partial<AnswerValue>) => void;
}) {
  const failed = isFailure(item, answer);

  return (
    <div>
      <p className="text-sm font-medium">
        {item.label}
        {item.required === false && <span className="text-text-muted"> (optional)</span>}
      </p>
      {item.help && <p className="text-xs text-text-muted">{item.help}</p>}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {(item.type === "pass_fail" || item.type === "pass_fail_na") && (
          <>
            {["pass", "fail"].map((value) => (
              <Button
                key={value}
                size="sm"
                variant={answer?.value === value && !answer?.na ? "primary" : "secondary"}
                disabled={disabled}
                onClick={() => onChange({ value, na: false })}
              >
                {value === "pass" ? "Pass" : "Fail"}
              </Button>
            ))}
            {/* Offered only where the template made it available — §15's two types, honoured. */}
            {allowsNotApplicable(item.type) && (
              <Button
                size="sm"
                variant={answer?.na ? "primary" : "secondary"}
                disabled={disabled}
                onClick={() => onChange({ na: true, value: null })}
              >
                N/A
              </Button>
            )}
          </>
        )}

        {(item.type === "numeric" || item.type === "instrument_reading") && (
          <div className="w-40">
            <Input
              inputMode="decimal"
              disabled={disabled}
              value={
                answer?.value === undefined || answer?.value === null ? "" : String(answer.value)
              }
              onChange={(event) =>
                onChange({
                  value: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            />
          </div>
        )}
        {(item.type === "numeric" || item.type === "instrument_reading") && (
          <span className="text-xs text-text-muted">
            {item.unit ?? ""}
            {item.min !== null || item.max !== null
              ? ` (${item.min ?? "—"} to ${item.max ?? "—"})`
              : ""}
          </span>
        )}

        {(item.type === "text" || item.type === "signature") && (
          <div className="w-full">
            <Textarea
              rows={2}
              disabled={disabled}
              value={typeof answer?.value === "string" ? answer.value : ""}
              onChange={(event) => onChange({ value: event.target.value })}
            />
          </div>
        )}

        {item.type === "select_single" && (
          <div className="w-56">
            <Select
              disabled={disabled}
              value={typeof answer?.value === "string" ? answer.value : ""}
              onChange={(event) => onChange({ value: event.target.value })}
            >
              <option value="">Choose…</option>
              {(item.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
        )}

        {item.type === "select_multi" &&
          (item.options ?? []).map((option) => {
            const chosen = Array.isArray(answer?.value) ? answer.value : [];
            return (
              <label key={option} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={chosen.includes(option)}
                  onChange={(event) =>
                    onChange({
                      value: event.target.checked
                        ? [...chosen, option]
                        : chosen.filter((entry) => entry !== option),
                    })
                  }
                />
                {option}
              </label>
            );
          })}

        {item.type === "photo" && (
          <p className="text-xs text-text-muted">
            Attach below, then record the file ids here as they upload.
          </p>
        )}
      </div>

      {/*
        §15's conditional logic, shown the moment it applies rather than at sign-off. A technician
        who has left site cannot tell you why something failed.
      */}
      {failed && !disabled && (
        <div className="mt-2 grid gap-2 rounded-md border-2 border-amber-400 bg-amber-50 p-2 sm:grid-cols-2">
          <div>
            <Label htmlFor={`cause-${item.key}`}>Cause</Label>
            <Input
              id={`cause-${item.key}`}
              value={answer?.cause ?? ""}
              onChange={(event) => onChange({ cause: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor={`action-${item.key}`}>Action taken</Label>
            <Input
              id={`action-${item.key}`}
              value={answer?.action ?? ""}
              onChange={(event) => onChange({ action: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
