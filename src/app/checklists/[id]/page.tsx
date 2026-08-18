"use client";

import { use, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ITEM_TYPES,
  ITEM_TYPE_LABELS,
  allowsNotApplicable,
  type ChecklistItem,
  type ChecklistSection,
  type ItemType,
} from "@/server/core/operations/checklist-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One checklist: read it, and — while it is a draft — change it.
 *
 * The editing rules are §15's, enforced at the service and mirrored here so the screen never offers
 * something the server will refuse. A published version shows its items read-only with a **Revise**
 * button; a draft shows the editor and a **Publish** button. There is no third state and no way to
 * edit something published, which is the whole point (docs/DECISIONS.md #93).
 */

const TONE: Record<string, StatusTone> = { active: "approved", draft: "pending", retired: "draft" };

export default function ChecklistDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const templates = trpc.operations.listChecklistTemplates.useQuery({ includeRetired: true });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();

  const canManage = (me.data?.permissions ?? []).includes("checklist.manage");
  const template = (templates.data ?? []).find((row) => row.id === id);

  const [draft, setDraft] = useState<ChecklistSection[] | null>(null);

  const refresh = () => void utils.operations.listChecklistTemplates.invalidate();
  const save = trpc.operations.saveChecklistDraft.useMutation({ onSuccess: refresh });
  const publish = trpc.operations.publishChecklistTemplate.useMutation({ onSuccess: refresh });
  const revise = trpc.operations.reviseChecklistTemplate.useMutation({ onSuccess: refresh });

  if (templates.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (!template) {
    return (
      <div>
        <PageHeader title="Not found" description="No checklist with that id." />
        <Link href="/checklists" className="text-sm underline">
          Back to checklists
        </Link>
      </div>
    );
  }

  const editable = template.status === "draft" && canManage;
  const sections = draft ?? template.sections;

  const patchItem = (sectionIndex: number, itemIndex: number, patch: Partial<ChecklistItem>) =>
    setDraft(
      sections.map((section, si) =>
        si !== sectionIndex
          ? section
          : {
              ...section,
              items: section.items.map((item, ii) =>
                ii !== itemIndex ? item : { ...item, ...patch },
              ),
            },
      ),
    );

  return (
    <div>
      <PageHeader
        title={template.name}
        description={template.description ?? undefined}
        actions={
          <StatusBadge tone={TONE[template.status] ?? "draft"}>
            v{template.version} {template.status}
          </StatusBadge>
        }
      />

      <Link href="/checklists" className="text-sm underline">
        Back to checklists
      </Link>

      {template.status === "retired" && (
        <p className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
          This version is retired. It is kept because checklists filled in against it cite it as the
          procedure they followed.
        </p>
      )}

      {sections.map((section, sectionIndex) => (
        <Card key={section.key} className="mt-4 p-4">
          <h2 className="text-sm font-semibold">{section.title}</h2>

          <ul className="mt-3 space-y-3">
            {section.items.map((item, itemIndex) => (
              <li
                key={item.key}
                className="border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                {!editable ? (
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="text-sm">
                        {item.label}
                        {item.required === false && (
                          <span className="text-text-muted"> (optional)</span>
                        )}
                      </p>
                      {item.help && <p className="text-xs text-text-muted">{item.help}</p>}
                    </div>
                    <p className="text-xs text-text-muted">
                      {ITEM_TYPE_LABELS[item.type]}
                      {item.min !== null || item.max !== null
                        ? ` · ${item.min ?? "—"} to ${item.max ?? "—"}${item.unit ? ` ${item.unit}` : ""}`
                        : ""}
                      {allowsNotApplicable(item.type) ? " · N/A allowed" : ""}
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Label htmlFor={`label-${item.key}`}>Question</Label>
                      <Input
                        id={`label-${item.key}`}
                        value={item.label}
                        onChange={(event) =>
                          patchItem(sectionIndex, itemIndex, { label: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor={`type-${item.key}`}>Answer type</Label>
                      <Select
                        id={`type-${item.key}`}
                        value={item.type}
                        onChange={(event) =>
                          patchItem(sectionIndex, itemIndex, {
                            type: event.target.value as ItemType,
                          })
                        }
                      >
                        {ITEM_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {ITEM_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex items-end gap-3 pb-2">
                      <label className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={item.required !== false}
                          onChange={(event) =>
                            patchItem(sectionIndex, itemIndex, { required: event.target.checked })
                          }
                        />
                        Must be answered
                      </label>
                    </div>

                    {(item.type === "numeric" || item.type === "instrument_reading") && (
                      <>
                        <div className="flex gap-2">
                          <div className="w-24">
                            <Label htmlFor={`min-${item.key}`}>Lowest</Label>
                            <Input
                              id={`min-${item.key}`}
                              inputMode="decimal"
                              value={item.min ?? ""}
                              onChange={(event) =>
                                patchItem(sectionIndex, itemIndex, {
                                  min:
                                    event.target.value === "" ? null : Number(event.target.value),
                                })
                              }
                            />
                          </div>
                          <div className="w-24">
                            <Label htmlFor={`max-${item.key}`}>Highest</Label>
                            <Input
                              id={`max-${item.key}`}
                              inputMode="decimal"
                              value={item.max ?? ""}
                              onChange={(event) =>
                                patchItem(sectionIndex, itemIndex, {
                                  max:
                                    event.target.value === "" ? null : Number(event.target.value),
                                })
                              }
                            />
                          </div>
                          <div className="w-20">
                            <Label htmlFor={`unit-${item.key}`}>Unit</Label>
                            <Input
                              id={`unit-${item.key}`}
                              value={item.unit ?? ""}
                              onChange={(event) =>
                                patchItem(sectionIndex, itemIndex, { unit: event.target.value })
                              }
                            />
                          </div>
                        </div>
                        <p className="self-end pb-2 text-xs text-text-muted">
                          A reading outside these fails, and a failure asks for its cause and
                          action. Leave both empty to record the number without judging it.
                        </p>
                      </>
                    )}

                    {(item.type === "select_single" || item.type === "select_multi") && (
                      <div className="sm:col-span-2">
                        <Label htmlFor={`options-${item.key}`}>Choices, one per line</Label>
                        <Textarea
                          id={`options-${item.key}`}
                          rows={3}
                          value={(item.options ?? []).join("\n")}
                          onChange={(event) =>
                            patchItem(sectionIndex, itemIndex, {
                              options: event.target.value.split("\n").filter((line) => line.trim()),
                            })
                          }
                        />
                      </div>
                    )}

                    <div className="sm:col-span-2">
                      <Label htmlFor={`help-${item.key}`}>Guidance (optional)</Label>
                      <Input
                        id={`help-${item.key}`}
                        value={item.help ?? ""}
                        onChange={(event) =>
                          patchItem(sectionIndex, itemIndex, { help: event.target.value })
                        }
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() =>
                          setDraft(
                            sections.map((s, si) =>
                              si !== sectionIndex
                                ? s
                                : { ...s, items: s.items.filter((_, ii) => ii !== itemIndex) },
                            ),
                          )
                        }
                      >
                        Remove this question
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {editable && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() =>
                setDraft(
                  sections.map((s, si) =>
                    si !== sectionIndex
                      ? s
                      : {
                          ...s,
                          items: [
                            ...s.items,
                            {
                              key: `item_${Date.now().toString(36)}`,
                              label: "New question",
                              type: "pass_fail" as ItemType,
                              required: true,
                              min: null,
                              max: null,
                              unit: null,
                              help: null,
                            },
                          ],
                        },
                  ),
                )
              }
            >
              Add a question
            </Button>
          )}
        </Card>
      ))}

      <div className="mt-4 flex flex-wrap gap-2">
        {editable && (
          <>
            <Button
              variant="secondary"
              disabled={save.isPending || !draft}
              onClick={() => save.mutate({ templateId: template.id, sections })}
            >
              Save draft
            </Button>
            <Button
              disabled={publish.isPending}
              onClick={async () => {
                if (draft) await save.mutateAsync({ templateId: template.id, sections });
                publish.mutate({ templateId: template.id });
              }}
            >
              Publish
            </Button>
          </>
        )}

        {template.status === "active" && canManage && (
          <Button
            variant="secondary"
            disabled={revise.isPending}
            onClick={() => revise.mutate({ templateId: template.id })}
          >
            Revise into v{template.version + 1}
          </Button>
        )}
      </div>

      {(save.error ?? publish.error ?? revise.error) && (
        <p className="mt-2 text-sm text-danger">
          {(save.error ?? publish.error ?? revise.error)!.message}
        </p>
      )}
    </div>
  );
}
