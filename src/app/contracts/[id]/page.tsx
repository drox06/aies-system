"use client";

import { use } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { DateCell } from "@/components/ui/cells";
import { PM_TICKET_LEAD_DAYS, daysUntil } from "@/server/core/operations/renewal-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One maintenance contract: what it covers, what it owes, and what has been raised against it.
 *
 * The planned visits are computed rather than stored, so the list on screen is the same list the
 * nightly sweep works from — see renewal-rules.ts. A stored schedule would drift the first time
 * somebody edited the term and nobody recalculated.
 */

const TONE: Record<string, StatusTone> = {
  active: "approved",
  draft: "pending",
  expired: "failed",
  cancelled: "draft",
  renewed: "info",
};

export default function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const contract = trpc.operations.getContract.useQuery({ contractId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();

  const canManage = (me.data?.permissions ?? []).includes("contract.manage");
  const activate = trpc.operations.activateContract.useMutation({
    onSuccess: () => void utils.operations.getContract.invalidate({ contractId: id }),
  });

  if (contract.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (!contract.data) {
    return (
      <div>
        <PageHeader title="Not found" description="No contract with that id." />
        <Link href="/contracts" className="text-sm underline">
          Back to contracts
        </Link>
      </div>
    );
  }

  const data = contract.data;
  const remaining = daysUntil(data.endDate);

  return (
    <div>
      <PageHeader
        title={data.number}
        description={data.account.name}
        actions={<StatusBadge tone={TONE[data.status] ?? "draft"}>{data.status}</StatusBadge>}
      />

      <Link href="/contracts" className="text-sm underline">
        Back to contracts
      </Link>

      <Card className="mt-4 p-4">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Term</dt>
            <dd>
              <DateCell value={data.startDate} /> to <DateCell value={data.endDate} />
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Remaining</dt>
            <dd>{remaining < 0 ? `${-remaining} days past` : `${remaining} days`}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Visits a year</dt>
            <dd>{data.visitsPerYear}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-text-muted">Value</dt>
            <dd className="tabular">
              ₱{(data.contractValue / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}
            </dd>
          </div>
        </dl>

        {data.status === "draft" && canManage && (
          <div className="mt-3">
            <Button
              disabled={activate.isPending}
              onClick={() => activate.mutate({ contractId: id })}
            >
              Start the contract
            </Button>
            <p className="mt-1 text-xs text-text-muted">
              Until it starts, no visits are raised and no renewal is watched for.
            </p>
          </div>
        )}
        {activate.error && <p className="mt-2 text-sm text-danger">{activate.error.message}</p>}
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">What it covers</h2>
        {data.equipment.length === 0 ? (
          <p className="mt-1 text-sm text-text-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {data.equipment.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>{item.tagNumber ?? item.serialNumber ?? item.description}</span>
                <span className="text-xs text-text-muted">
                  {item.nextPMDueAt ? (
                    <>
                      next service <DateCell value={item.nextPMDueAt} />
                    </>
                  ) : (
                    "no service date recorded"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">Visits it owes</h2>
        <p className="mt-1 text-xs text-text-muted">
          Computed from the term and the visit count, so this is the same list the nightly job works
          from. A ticket is raised {PM_TICKET_LEAD_DAYS} days before each one.
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {data.plannedVisits.map((visit, index) => {
            const days = daysUntil(visit);
            return (
              <li key={index} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  Visit {index + 1} — <DateCell value={visit} />
                </span>
                <span className="text-xs text-text-muted">
                  {days < 0 ? `${-days} days ago` : `in ${days} days`}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {data.tickets.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold">Preventive tickets raised</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.tickets.map((ticket) => (
              <li key={ticket.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/tickets/${ticket.id}`} className="underline">
                  {ticket.number}
                </Link>
                <span className="text-xs text-text-muted">
                  {ticket.status}
                  {ticket.requiredByDate && (
                    <>
                      {" · due "}
                      <DateCell value={ticket.requiredByDate} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
