"use client";

import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/layout";
import { NewChecklist } from "./NewChecklist";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * §15's checklists, as a place you can actually get to.
 *
 * The panel on a ticket was the only route to these until 2026-08-18, which meant the eleven seeded
 * templates were invisible the moment there were no tickets — and the company, quite reasonably,
 * reported that they did not exist. A library of procedures is a thing in its own right: somebody
 * reviews it, revises it and prints it without any particular job in front of them.
 *
 * Reading is gated on `ticket.view` rather than `checklist.manage`: everybody who does the work
 * should be able to read the procedure they are held to. Changing one is the narrower right.
 */

const TONE: Record<string, StatusTone> = {
  active: "approved",
  draft: "pending",
  retired: "draft",
};

const STAGE_LABELS: Record<string, string> = {
  pre_quotation: "Before the quotation",
  mobilization: "Mobilisation",
  materials: "Materials",
  execution: "On the job",
  qa: "Quality",
  testing_commissioning: "Testing and commissioning",
  safety: "Safety",
  after_sales: "After sales",
  demobilization: "Demobilisation",
  delivery: "Delivery",
};

export default function ChecklistsPage() {
  const templates = trpc.operations.listChecklistTemplates.useQuery({ includeRetired: true });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManage = (me.data?.permissions ?? []).includes("checklist.manage");

  const rows = templates.data ?? [];
  const stages = [...new Set(rows.map((row) => row.stage))];

  return (
    <div>
      <PageHeader
        title="Checklists"
        description="The procedures work is confirmed against. A published version is never edited — revising one creates the next."
      />

      {/*
        Creating one, which this screen could not do.

        It nearly read as dead code: `saveChecklistDraft` was wired and looked like it superseded
        `createChecklistTemplate`. It does not — `saveDraftService` requires an existing template and
        only edits. The eleven seeded checklists could be revised forever and a twelfth could never
        exist. docs/DECISIONS.md #135's triage, corrected.
      */}
      {canManage && <NewChecklist onCreated={() => void templates.refetch()} />}

      {templates.isPending && <p className="text-sm text-text-muted">Loading…</p>}
      {templates.error && <p className="text-sm text-danger">{templates.error.message}</p>}

      {templates.data?.length === 0 && (
        <Card className="p-4">
          <p className="text-sm">
            No checklists yet. They are created by the seed — run <code>npx prisma db seed</code>,
            or add one here if you hold the right to.
          </p>
        </Card>
      )}

      {stages.map((stage) => (
        <section key={stage} className="mt-5">
          <h2 className="text-sm font-semibold text-text-muted">{STAGE_LABELS[stage] ?? stage}</h2>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {rows
              .filter((row) => row.stage === stage)
              .map((row) => {
                const items = row.sections.flatMap((section) => section.items);
                return (
                  <li key={row.id}>
                    <Link href={`/checklists/${row.id}`} className="block">
                      <Card className="h-full p-3 transition-colors hover:border-brand">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-sm font-medium">{row.name}</p>
                          <StatusBadge tone={TONE[row.status] ?? "draft"}>
                            v{row.version} {row.status}
                          </StatusBadge>
                        </div>
                        {row.description && (
                          <p className="mt-1 text-xs text-text-muted">{row.description}</p>
                        )}
                        <p className="mt-1 text-xs text-text-muted">
                          {items.length} item{items.length === 1 ? "" : "s"} across{" "}
                          {row.sections.length} section{row.sections.length === 1 ? "" : "s"}
                        </p>
                      </Card>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}

      {canManage && rows.length > 0 && (
        <p className="mt-6 text-xs text-text-muted">
          To change a published checklist, open it and revise — that creates the next version and
          retires this one, so anything already signed keeps meaning what it meant.
        </p>
      )}
    </div>
  );
}
