"use client";

import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import { QUOTE_SILENCE_FOLLOW_UP_DAYS, STALE_ACCOUNT_DAYS } from "@/server/core/crm/pipeline-rules";
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
  const inspections = trpc.crm.myInspections.useQuery();
  const data = myDay.data;
  const myInspections = inspections.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My day"
        description="What is overdue, what is waiting on you, and who you have not spoken to."
      />

      {myDay.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {/* §5's site inspections, first because they are the only item here with a plant visit and a
          gate pass behind them — everything else on this page can be done from a desk. A technician
          sees this section and nothing else, since they own no inquiries. */}
      {myInspections.length > 0 && (
        <Card className="mb-4 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Site inspections assigned to you</h2>
            <span className="tabular text-xs text-text-muted">{myInspections.length}</span>
          </div>
          <ul className="mt-2 divide-y divide-border">
            {myInspections.map((item) => (
              <li key={item.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/crm/inquiries/${item.inquiry.id}`}
                    className="min-w-0 flex-1 truncate font-medium hover:underline"
                  >
                    <span className="tabular text-text-muted">{item.inquiry.number}</span>{" "}
                    {item.purpose}
                  </Link>
                  {item.dueAt ? (
                    <StatusBadge tone={new Date(item.dueAt) < new Date() ? "failed" : "pending"}>
                      by <DateCell value={item.dueAt} />
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="draft">no date set</StatusBadge>
                  )}
                </div>
                {item.site?.name && (
                  <p className="mt-0.5 text-xs text-text-muted">{item.site.name}</p>
                )}
                {item.questions && (
                  <p className="mt-0.5 text-xs whitespace-pre-wrap">{item.questions}</p>
                )}
                {item.requiredOutputs.length > 0 && (
                  <p className="mt-0.5 text-xs text-text-muted">
                    Bring back: {item.requiredOutputs.join(", ").replace(/_/g, " ")}
                  </p>
                )}
                {/* The commonest cause of a wasted trip, so it is on the list rather than one
                    click away. */}
                {item.site?.accessNotes && (
                  <p className="mt-1 rounded border border-border bg-surface-2 p-1.5 text-xs">
                    <span className="font-medium">Site access:</span> {item.site.accessNotes}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

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

          {/* The company's seven-day rule. Placed above the sixty-day list because it is the more
              urgent of the two: a quotation that has gone quiet for a week is still recoverable by
              a phone call, and a customer nobody has dealt with in two months is not an emergency. */}
          <Card className="p-4">
            <h2 className="text-sm font-semibold">
              Quotations with no answer after {QUOTE_SILENCE_FOLLOW_UP_DAYS} days
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              Sent, and nothing since — no feedback, no negotiation, no purchase order.
            </p>
            {data.silentQuotations.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                Nothing you have sent is waiting on a customer.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {data.silentQuotations.map((quotation) => (
                  <li key={quotation.id} className="flex items-center justify-between gap-3 py-2">
                    <Link
                      href={`/quotations/${quotation.id}`}
                      className="min-w-0 flex-1 truncate text-sm hover:underline"
                    >
                      <span className="tabular text-text-muted">{quotation.number}</span>{" "}
                      <span className="font-medium">{quotation.title}</span>
                      <span className="text-text-muted"> · {quotation.accountName}</span>
                    </Link>
                    <span className="shrink-0 text-xs text-warning">
                      {quotation.daysSilent}d silent
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">
              Accounts with no activity in {STALE_ACCOUNT_DAYS} days
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {/* Renamed from "not contacted" at the company's instruction, and it now means
                  something wider — see ACCOUNT_ACTIVITY_KINDS. */}
              Counted from purchase orders, quotations sent, inquiries received and logged calls —
              not from edits to the record.
            </p>
            {data.staleAccounts.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                Every account you own has had something happen recently.
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
                          {/* Which kind, not just when: "last order 84 days ago" and "last call 84
                              days ago" are different problems. */}
                          {account.lastActivityKind ?? "last"}{" "}
                          <DateCell value={account.lastContactAt} />
                        </>
                      ) : (
                        "nothing ever"
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
