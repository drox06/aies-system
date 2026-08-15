"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * The customer's plants.
 *
 * §1 says why these are real records: "each has plants, each plant has equipment, and the same
 * account may run several unrelated inquiries at once through different engineers." Everything
 * downstream already points at a `Site` — inquiries, quotations, inspection requests, and now
 * contacts — and every one of those pickers was empty, because nothing in the app could create one.
 *
 * **Access notes are given their own field and their own emphasis**, because §2 singles them out and
 * because they are the difference between a technician arriving at a refinery with the right gate
 * pass and losing a day. A plant is not just an address.
 */
export function SitesPanel({
  accountId,
  contacts,
}: {
  accountId: string;
  contacts: { id: string; firstName: string; lastName: string }[];
}) {
  const utils = trpc.useUtils();
  const sites = trpc.crm.listSites.useQuery({ accountId });
  const upsert = trpc.crm.upsertSite.useMutation();
  const remove = trpc.crm.deleteSite.useMutation();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = sites.data ?? [];
  const refresh = () => {
    void utils.crm.listSites.invalidate({ accountId });
    void utils.crm.getAccount.invalidate({ accountId });
    // The contact form's plant dropdown reads the same list.
    void utils.crm.listContacts.invalidate({ accountId });
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Plants and locations</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Where the work actually happens. Inquiries, quotations and site visits all point at one
            of these.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add a plant"}
        </Button>
      </div>

      {adding && (
        <SiteForm
          contacts={contacts}
          busy={upsert.isPending}
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            try {
              await upsert.mutateAsync({ accountId, ...values });
              toastSuccess(`Added ${values.name}.`);
              setAdding(false);
              refresh();
            } catch (error) {
              toastError(error);
            }
          }}
        />
      )}

      {rows.length === 0 && !adding && (
        <p className="mt-1 text-sm text-text-muted">
          No plants recorded. Add one and it becomes selectable on inquiries, quotations and site
          inspections.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((site) =>
            editing === site.id ? (
              <li key={site.id} className="py-2">
                <SiteForm
                  contacts={contacts}
                  busy={upsert.isPending}
                  initial={{
                    name: site.name,
                    accessNotes: site.accessNotes ?? "",
                    contactId: site.contactId ?? "",
                  }}
                  onCancel={() => setEditing(null)}
                  onSave={async (values) => {
                    try {
                      await upsert.mutateAsync({ accountId, siteId: site.id, ...values });
                      toastSuccess("Saved.");
                      setEditing(null);
                      refresh();
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                />
              </li>
            ) : (
              <li key={site.id} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{site.name}</span>
                  {site.contacts.length > 0 && (
                    <span className="text-xs text-text-muted">
                      {site.contacts.length} contact{site.contacts.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {site._count.inquiries > 0 && (
                    <StatusBadge tone="info">{site._count.inquiries} inquiries</StatusBadge>
                  )}
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(site.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      disabled={remove.isPending}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync({ siteId: site.id });
                          toastSuccess("Removed.");
                          refresh();
                        } catch (error) {
                          // Carries the service's own refusal, which names what still points at it.
                          toastError(error);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </div>
                {site.accessNotes && (
                  <p className="mt-0.5 rounded bg-surface-2 p-1.5 text-xs whitespace-pre-wrap">
                    <span className="font-medium">Getting in:</span> {site.accessNotes}
                  </p>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}

interface SiteValues {
  name: string;
  accessNotes: string;
  contactId: string;
}

function SiteForm({
  contacts,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  contacts: { id: string; firstName: string; lastName: string }[];
  initial?: SiteValues;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: {
    name: string;
    accessNotes: string | null;
    contactId: string | null;
  }) => Promise<void>;
}) {
  const [values, setValues] = useState<SiteValues>(
    initial ?? { name: "", accessNotes: "", contactId: "" },
  );

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="s-name">Plant name *</Label>
          <Input
            id="s-name"
            value={values.name}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            placeholder="Balibago Water Treatment Plant"
          />
        </div>
        <div>
          <Label htmlFor="s-contact">Main contact at this plant</Label>
          <Select
            id="s-contact"
            value={values.contactId}
            onChange={(e) => setValues((v) => ({ ...v, contactId: e.target.value }))}
          >
            <option value="">Nobody nominated</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.firstName} {contact.lastName}
              </option>
            ))}
          </Select>
          {contacts.length === 0 && (
            <p className="mt-0.5 text-xs text-text-muted">
              Add a contact first and they become selectable here.
            </p>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="s-access">Getting in — gate pass, PPE, induction</Label>
        <Textarea
          id="s-access"
          rows={3}
          value={values.accessNotes}
          onChange={(e) => setValues((v) => ({ ...v, accessNotes: e.target.value }))}
          placeholder="Gate pass needed 48h ahead through the security office. Full PPE plus H2S monitor. Annual safety induction required before first visit."
        />
        <p className="mt-0.5 text-xs text-text-muted">
          {/* §2 names this field specifically, and the reason is a lost day at a gate. */}
          This is what stops somebody arriving without the right paperwork and losing a day.
        </p>
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || values.name.trim().length === 0}
          onClick={() =>
            void onSave({
              name: values.name,
              accessNotes: values.accessNotes || null,
              contactId: values.contactId || null,
            })
          }
        >
          {busy ? "Saving…" : "Save plant"}
        </Button>
      </div>
    </div>
  );
}
