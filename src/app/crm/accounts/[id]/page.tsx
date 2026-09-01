"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { DateCell, MoneyCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { assessAccreditation } from "@/server/core/crm/accreditation-rules";
import { humanStatus } from "@/server/core/crm/inquiry-lifecycle";
import { trpc } from "@/lib/trpc/client";
import { AccreditationPanel } from "../../accreditations/AccreditationPanel";
import { AccountDialog } from "../AccountDialog";
import { ContactsPanel } from "./ContactsPanel";
import { LogActivityForm } from "./LogActivityForm";
import { SitesPanel } from "./SitesPanel";

/**
 * §6's Account 360.
 *
 * §6 asks for: "contacts, sites, open inquiries, quotation history with win rate, orders, open AR
 * balance (permission-gated), installed equipment (populated by module 04), service history, all
 * activities, all documents."
 *
 * Five of those belong to modules that do not exist. They are **not** stubbed as empty panels — a
 * page of headings with nothing under them makes the real sections harder to find and trains people
 * to scroll past. One honest line at the bottom names what is coming and which module brings it,
 * which is information; six empty cards are not.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  active: "active",
  dormant: "draft",
  blacklisted: "failed",
};

export default function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [editing, setEditing] = useState(false);
  const [editingAccreditation, setEditingAccreditation] = useState(false);

  const whoami = trpc.system.whoami.useQuery();
  // §9 puts accreditation with the Admin Manager, and the president and vice-president.
  const mayManageAccreditation = (whoami.data?.permissions ?? []).includes("accreditation.manage");

  const account = trpc.crm.getAccount.useQuery({ accountId: id });
  const inquiries = trpc.crm.listInquiries.useQuery({ accountId: id, pageSize: 100 });
  const accreditation = trpc.crm.getAccreditation.useQuery({ accountId: id });
  const activities = trpc.crm.listActivities.useQuery({
    entityType: "CustomerAccount",
    entityId: id,
  });

  if (account.isPending) return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  if (account.error) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-6">
          <p className="font-medium">This account is not available.</p>
          <p className="mt-1 text-sm text-text-muted">{account.error.message}</p>
          <Button asChild variant="ghost" size="sm" className="mt-3">
            <Link href="/crm/accounts">Back to accounts</Link>
          </Button>
        </Card>
      </div>
    );
  }

  const data = account.data;
  const rows = inquiries.data?.rows ?? [];
  const open = rows.filter((row) => !["won", "lost", "disqualified"].includes(row.status));
  const closed = rows.filter((row) => ["won", "lost"].includes(row.status));
  const won = closed.filter((row) => row.status === "won").length;

  // Derived here rather than served, because the status is derived everywhere else too — a record
  // saying `accredited` with a past expiry reads as expired, and nothing runs before a page opens.
  const accreditationHealth = accreditation.data
    ? assessAccreditation({
        status: accreditation.data.status,
        expiresAt: accreditation.data.expiresAt ? new Date(accreditation.data.expiresAt) : null,
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={data.name}
        description={[data.code, data.industry, data.legalName].filter(Boolean).join(" · ")}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{data.status}</span>
            </StatusBadge>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        }
      />

      <RecordLayout aside={<ActivityFeed entityType="CustomerAccount" entityId={id} />}>
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Details</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Field label="TIN">{data.tin ?? "—"}</Field>
              <Field label="Type">{data.accountType}</Field>
              <Field label="Phone">{data.phone ?? "—"}</Field>
              <Field label="Email">{data.email ?? "—"}</Field>
              <Field label="Credit limit">
                <MoneyCell value={data.creditLimit?.toString() ?? null} currency={data.currency} />
              </Field>
              <Field label="Parent">
                {data.parent ? (
                  <Link href={`/crm/accounts/${data.parent.id}`} className="hover:underline">
                    {data.parent.name}
                  </Link>
                ) : (
                  "—"
                )}
              </Field>
            </dl>
          </Card>

          {/* §5b wants accreditation visible on the account: "the salesperson should see that
              before writing the quote, not after."

              It is also **editable** here for whoever manages accreditations, which it was not
              before. The register at /crm/accreditations lists records that already exist, and its
              own empty state said to come here and start one — but this card was read-only, so
              there was no way in the app to start the first accreditation, upload a certificate or
              type an expiry date at all. A dead end between two screens that each pointed at the
              other. */}
          <Card className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Accreditation</h2>
              {mayManageAccreditation && accreditation.data && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingAccreditation((v) => !v)}
                >
                  {editingAccreditation ? "Done" : "Update certificate or expiry"}
                </Button>
              )}
            </div>

            {accreditation.data && accreditationHealth ? (
              <p className="mt-1 text-sm">
                <StatusBadge
                  tone={
                    accreditationHealth.blocksSelling
                      ? "failed"
                      : accreditationHealth.effectiveStatus === "renewal_due"
                        ? "pending"
                        : "approved"
                  }
                >
                  <span className="capitalize">
                    {humanStatus(accreditationHealth.effectiveStatus)}
                  </span>
                </StatusBadge>
                {accreditation.data.expiresAt && (
                  <span className="ml-2 text-text-muted">
                    expires <DateCell value={accreditation.data.expiresAt} />
                  </span>
                )}
                {accreditationHealth.blocksSelling && (
                  <span className="mt-1 block text-xs text-danger">
                    This customer cannot currently issue AIES a PO.
                  </span>
                )}
              </p>
            ) : (
              !mayManageAccreditation && (
                <p className="mt-1 text-sm text-text-muted">No accreditation record.</p>
              )
            )}

            {/* The panel handles both states: it offers "Start accreditation" when there is no
                record, and the certificate upload, expiry date and renewal controls once there is.
                Shown unconditionally when there is nothing yet, because a record that does not
                exist has nothing to summarise and the only useful thing on the card is the button
                that creates it. */}
            {mayManageAccreditation && (!accreditation.data || editingAccreditation) && (
              <div className={accreditation.data ? "mt-3 border-t border-border pt-3" : "mt-2"}>
                <AccreditationPanel accountId={id} onChanged={() => void accreditation.refetch()} />
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Open inquiries</h2>
              <span className="tabular text-xs text-text-muted">{open.length}</span>
            </div>
            {open.length === 0 ? (
              <p className="mt-1 text-sm text-text-muted">Nothing open.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {open.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
                    <Link
                      href={`/crm/inquiries/${row.id}`}
                      className="min-w-0 flex-1 truncate hover:underline"
                    >
                      <span className="tabular text-text-muted">{row.number}</span>{" "}
                      <span className="font-medium">{row.subject}</span>
                    </Link>
                    <StatusBadge tone={row.sla.breached ? "failed" : "draft"}>
                      <span className="capitalize">{humanStatus(row.status)}</span>
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
            {closed.length > 0 && (
              <p className="mt-3 border-t border-border pt-2 text-xs text-text-muted">
                {/* §6 asks for "quotation history with win rate". Quotations are module 02, so this
                    is the inquiry-level version — honest about what it counts. */}
                {won} of {closed.length} closed inquiries won (
                {Math.round((won / closed.length) * 100)}%). Quotation-level win rate arrives with
                module 02.
              </p>
            )}
          </Card>

          {/* Plants before contacts, because a contact form asks which plant somebody runs and the
              answer has to exist first. */}
          <SitesPanel accountId={id} />

          <ContactsPanel accountId={id} sites={data.sites} />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Contact history</h2>
            <p className="mt-0.5 text-xs text-text-muted">
              Calls, meetings and site visits. This is what &ldquo;not contacted in 60 days&rdquo;
              counts — editing the record does not.
            </p>
            <LogActivityForm accountId={id} onLogged={() => void activities.refetch()} />
            {(activities.data ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">Nothing logged yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {(activities.data ?? []).map((activity) => (
                  <li key={activity.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{activity.subject}</span>
                      <StatusBadge tone="draft">
                        <span className="capitalize">{humanStatus(activity.type)}</span>
                      </StatusBadge>
                      <span className="text-xs text-text-muted">
                        <DateCell value={activity.occurredAt} /> · {activity.createdByLabel}
                      </span>
                    </div>
                    {activity.body && (
                      <p className="mt-0.5 text-xs whitespace-pre-wrap">{activity.body}</p>
                    )}
                    {activity.outcome && (
                      <p className="mt-0.5 text-xs text-text-muted">Outcome: {activity.outcome}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-xs text-text-muted">
            Still to come on this page: quotation history and win rate (module 02), orders (03),
            open AR balance (05, permission-gated), installed equipment and service history (04),
            and controlled documents (07).
          </p>
        </div>
      </RecordLayout>

      <AccountDialog
        open={editing}
        onOpenChange={setEditing}
        accountId={id}
        onSaved={() => void account.refetch()}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
