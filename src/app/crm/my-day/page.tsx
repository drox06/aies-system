"use client";

import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import { STALE_ACCOUNT_DAYS } from "@/server/core/crm/pipeline-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's My Day.
 *
 * §1: "A salesperson's real question is 'who haven't I talked to in 60 days, and what's stuck?'
 * Design for that question." This page is that question, in four lists, and nothing else — no
 * charts, no scores, no summary tiles. Every row is something to act on today.
 *
 * §6 also lists "quotes expiring this week". That belongs to module 02 and is not stubbed here: an
 * empty panel that never fills is how people learn to skim past a section.
 */
export default function MyDayPage() {
  const myDay = trpc.crm.myDay.useQuery();
  const data = myDay.data;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My day"
        description="What is overdue, what is waiting on you, and who you have not spoken to."
      />

      {myDay.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {data && (
        <div className="space-y-4">
          <Section
            title="Overdue follow-ups"
            hint="You set a follow-up date and it has passed."
            empty="Nothing overdue."
            rows={data.overdueFollowUps}
            renderMeta={(row) => (
              <span className="text-danger">
                due <DateCell value={row.nextFollowUpAt} />
              </span>
            )}
          />

          <Section
            title="Awaiting your action"
            hint="New, acknowledged or under evaluation — the ball is with you."
            empty="Nothing waiting on you."
            rows={data.awaitingMyAction}
            renderMeta={(row) => (
              <>
                <StatusBadge tone={row.slaBreached ? "failed" : "draft"}>
                  <span className="capitalize">{humanStatus(row.status)}</span>
                </StatusBadge>
                <span className="text-text-muted">{row.ageDays}d old</span>
              </>
            )}
          />

          <Section
            title="Needs a next step"
            hint="§6: nothing is allowed to sit with no next step. Open each one and set a follow-up date."
            empty="Everything live has a next step."
            rows={data.needsNextStep}
            renderMeta={(row) => <span className="text-text-muted">{row.ageDays}d old</span>}
          />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">
              Accounts not contacted in {STALE_ACCOUNT_DAYS} days
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              Counted from logged calls, meetings, site visits and emails — not from edits to the
              record.
            </p>
            {data.staleAccounts.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                Every account you own has been contacted recently.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {data.staleAccounts.map((account) => (
                  <li key={account.id} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      href={`/crm/accounts/${account.id}`}
                      className="min-w-0 flex-1 truncate text-sm hover:underline"
                    >
                      <span className="font-medium">{account.name}</span>
                      <span className="text-text-muted"> · {account.code}</span>
                    </Link>
                    <span className="shrink-0 text-xs text-text-muted">
                      {account.lastContactAt ? (
                        <>
                          last <DateCell value={account.lastContactAt} />
                        </>
                      ) : (
                        "never logged"
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

interface Row {
  id: string;
  number: string;
  subject: string;
  status: string;
  ageDays: number;
  slaBreached: boolean;
  nextFollowUpAt: string | Date | null;
  accountName: string | null;
}

function Section({
  title,
  hint,
  empty,
  rows,
  renderMeta,
}: {
  title: string;
  hint: string;
  empty: string;
  rows: Row[];
  renderMeta: (row: Row) => React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="tabular text-xs text-text-muted">{rows.length}</span>
      </div>
      <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
      {rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link
                href={`/crm/inquiries/${row.id}`}
                className="min-w-0 flex-1 truncate text-sm hover:underline"
              >
                <span className="tabular text-text-muted">{row.number}</span>{" "}
                <span className="font-medium">{row.subject}</span>
                {row.accountName && <span className="text-text-muted"> · {row.accountName}</span>}
              </Link>
              <span className="flex shrink-0 items-center gap-2 text-xs">{renderMeta(row)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
