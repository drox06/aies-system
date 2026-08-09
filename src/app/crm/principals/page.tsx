"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MoneyCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { humanStage, PRINCIPAL_STAGES } from "@/server/core/crm/principal-lifecycle";
import { trpc } from "@/lib/trpc/client";
import { PrincipalDialog } from "./PrincipalDialog";
import { PrincipalPanel } from "./PrincipalPanel";

/**
 * specs/01-crm-inquiry.md §5c — EM's acquisition pipeline.
 *
 * A board rather than a table, because §5c asks for "the same treatment as the sales pipeline" and
 * the question this screen answers is "where is everything?", not "what are the details of one
 * row?". Six columns, in the order §5c lists them; `declined` and `dormant` are folded into a
 * quieter section below, since a board where a third of the columns are dead ends reads as failure
 * rather than as progress.
 */

const STAGE_TONE: Record<string, StatusTone> = {
  identified: "draft",
  contacted: "info",
  in_discussion: "info",
  samples_pricing: "pending",
  agreement_draft: "pending",
  appointed: "approved",
  declined: "failed",
  dormant: "cancelled",
};

const ACTIVE_STAGES = PRINCIPAL_STAGES.filter((s) => s !== "declined" && s !== "dormant");
const PARKED_STAGES = ["declined", "dormant"] as const;

export default function PrincipalsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = trpc.crm.listPrincipals.useQuery({});

  const rows = list.data ?? [];
  const byStage = (stage: string) => rows.filter((row) => row.stage === stage);
  const parked = rows.filter((row) => PARKED_STAGES.includes(row.stage as "declined"));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Principal suppliers"
        description="Manufacturers AIES is pursuing, and the agreements and price lists behind the ones it has."
        actions={<Button onClick={() => setDialogOpen(true)}>Add prospect</Button>}
      />

      {list.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {!list.isPending && rows.length === 0 && (
        <Card className="p-4">
          <EmptyState
            title="No principal prospects yet."
            description="Add the first manufacturer you are talking to. The pipeline works the same way as the sales one."
            action={<Button onClick={() => setDialogOpen(true)}>Add prospect</Button>}
          />
        </Card>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {ACTIVE_STAGES.map((stage) => {
            const column = byStage(stage);
            return (
              <section key={stage} className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold capitalize">{humanStage(stage)}</h2>
                  <span className="tabular text-xs text-text-muted">{column.length}</span>
                </div>
                <div className="space-y-2">
                  {column.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setOpenId(row.id)}
                      className="w-full rounded-md border border-border bg-surface p-2.5 text-left hover:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
                    >
                      <p className="truncate text-sm font-medium">{row.companyName}</p>
                      {row.country && (
                        <p className="truncate text-xs text-text-muted">{row.country}</p>
                      )}
                      {row.productLines.length > 0 && (
                        <p className="mt-1 truncate text-xs text-text-muted">
                          {row.productLines.join(", ")}
                        </p>
                      )}
                      {row.estimatedOpportunity && (
                        <p className="mt-1 text-xs">
                          <MoneyCell value={row.estimatedOpportunity} />
                        </p>
                      )}
                      <PrincipalFlags health={row.health} />
                    </button>
                  ))}
                  {column.length === 0 && (
                    <p className="rounded border border-dashed border-border p-2 text-xs text-text-muted">
                      Nothing here.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {parked.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold">Declined and dormant</h2>
          <ul className="mt-2 divide-y divide-border">
            {parked.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                <button
                  type="button"
                  onClick={() => setOpenId(row.id)}
                  className="min-w-0 flex-1 text-left text-sm hover:underline"
                >
                  <span className="font-medium">{row.companyName}</span>
                  {row.country && <span className="text-text-muted"> · {row.country}</span>}
                </button>
                <StatusBadge tone={STAGE_TONE[row.stage] ?? "draft"}>
                  <span className="capitalize">{humanStage(row.stage)}</span>
                </StatusBadge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PrincipalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => void list.refetch()}
      />
      {openId && (
        <PrincipalPanel
          prospectId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void list.refetch()}
        />
      )}
    </div>
  );
}

/**
 * §5c's two expiry dates, on the card.
 *
 * A lapsed price list is the one that matters most and is easiest to miss — §5c calls quoting from
 * one "a margin incident waiting to happen" — so it gets the loudest treatment the badge scale
 * allows, and only once appointed, since a prospect nobody has appointed is not being quoted from.
 */
function PrincipalFlags({
  health,
}: {
  health: {
    agreement: string;
    priceList: string;
    priceListUnsafeToQuote: boolean;
    agreementDaysRemaining: number | null;
    priceListDaysRemaining: number | null;
  };
}) {
  const flags: { tone: StatusTone; label: string }[] = [];

  if (health.priceListUnsafeToQuote) {
    flags.push({ tone: "failed", label: "Price list lapsed" });
  } else if (health.priceList === "expiring") {
    flags.push({ tone: "pending", label: `Price list ${health.priceListDaysRemaining}d` });
  }

  if (health.agreement === "expired") {
    flags.push({ tone: "failed", label: "Agreement expired" });
  } else if (health.agreement === "expiring") {
    flags.push({ tone: "pending", label: `Agreement ${health.agreementDaysRemaining}d` });
  }

  if (flags.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {flags.map((flag) => (
        <StatusBadge key={flag.label} tone={flag.tone}>
          {flag.label}
        </StatusBadge>
      ))}
    </div>
  );
}
