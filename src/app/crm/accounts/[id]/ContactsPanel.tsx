"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Everyone at this customer, and the form to add another.
 *
 * The company's reason for asking, in their words: *"this will help faster pin-pointing of client
 * to coordinate, or this is needed when handling multiple plant locations of 1 client."* Both
 * halves are in the layout — contacts are **grouped by plant**, because the question being asked is
 * never "who do we know here" but "who do I ring about Plant 2".
 *
 * The model has supported this since session 2. The page could only ever show the list; there was
 * no way to add to it.
 */
export function ContactsPanel({
  accountId,
  sites,
}: {
  accountId: string;
  sites: { id: string; name: string }[];
}) {
  const utils = trpc.useUtils();
  const contacts = trpc.crm.listContacts.useQuery({ accountId });
  const upsert = trpc.crm.upsertContact.useMutation();
  const remove = trpc.crm.deleteContact.useMutation();

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = contacts.data ?? [];
  const refresh = () => {
    void utils.crm.listContacts.invalidate({ accountId });
    void utils.crm.getAccount.invalidate({ accountId });
  };

  // Grouped by plant, with the people who belong to the company rather than to a site first —
  // a purchasing manager sits at head office and is who you ring about every plant.
  const groups = new Map<string, typeof rows>();
  for (const contact of rows) {
    const key = contact.site?.name ?? "";
    groups.set(key, [...(groups.get(key) ?? []), contact]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Contacts</h2>
        <Button variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add a contact"}
        </Button>
      </div>

      {adding && (
        <ContactForm
          sites={sites}
          busy={upsert.isPending}
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            try {
              await upsert.mutateAsync({ accountId, ...values });
              toastSuccess(`Added ${values.firstName} ${values.lastName}.`);
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
          Nobody recorded yet. One name with a mobile number is worth more here than every other
          field on this page.
        </p>
      )}

      {ordered.map(([siteName, people]) => (
        <div key={siteName || "no-site"} className="mt-3">
          {rows.some((c) => c.site) && (
            <p className="text-xs font-medium text-text-muted">
              {siteName || "No particular plant"}
            </p>
          )}
          <ul className="mt-1 divide-y divide-border">
            {people.map((contact) =>
              editing === contact.id ? (
                <li key={contact.id} className="py-2">
                  <ContactForm
                    sites={sites}
                    busy={upsert.isPending}
                    initial={{
                      siteId: contact.siteId ?? "",
                      firstName: contact.firstName,
                      lastName: contact.lastName,
                      position: contact.position ?? "",
                      department: contact.department ?? "",
                      email: contact.email ?? "",
                      mobile: contact.mobile ?? "",
                      phone: contact.phone ?? "",
                      isPrimary: contact.isPrimary,
                      isDecisionMaker: contact.isDecisionMaker,
                      notes: contact.notes ?? "",
                    }}
                    onCancel={() => setEditing(null)}
                    onSave={async (values) => {
                      try {
                        await upsert.mutateAsync({ accountId, contactId: contact.id, ...values });
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
                <li key={contact.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="text-sm font-medium">
                    {contact.firstName} {contact.lastName}
                  </span>
                  {contact.isPrimary && <StatusBadge tone="info">Primary</StatusBadge>}
                  {contact.isDecisionMaker && (
                    <StatusBadge tone="approved">Decision maker</StatusBadge>
                  )}
                  <span className="text-sm text-text-muted">
                    {[contact.position, contact.department].filter(Boolean).join(", ")}
                  </span>
                  <span className="text-sm">
                    {/* Tappable. Spec.md §6.6 expects this to work on a phone in a plant, and the
                        single most common thing anybody does with a contact is ring them. */}
                    {contact.mobile && (
                      <a href={`tel:${contact.mobile}`} className="text-blue-600 hover:underline">
                        {contact.mobile}
                      </a>
                    )}
                    {contact.mobile && contact.email && (
                      <span className="text-text-muted"> · </span>
                    )}
                    {contact.email && (
                      <a href={`mailto:${contact.email}`} className="text-blue-600 hover:underline">
                        {contact.email}
                      </a>
                    )}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(contact.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      disabled={remove.isPending}
                      onClick={async () => {
                        try {
                          const result = await remove.mutateAsync({ contactId: contact.id });
                          toastSuccess(
                            result.wasPrimary
                              ? "Removed. This account now has no primary contact."
                              : "Removed.",
                          );
                          refresh();
                        } catch (error) {
                          toastError(error);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </Card>
  );
}

interface ContactValues {
  siteId: string;
  firstName: string;
  lastName: string;
  position: string;
  department: string;
  email: string;
  mobile: string;
  phone: string;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  notes: string;
}

const EMPTY: ContactValues = {
  siteId: "",
  firstName: "",
  lastName: "",
  position: "",
  department: "",
  email: "",
  mobile: "",
  phone: "",
  isPrimary: false,
  isDecisionMaker: false,
  notes: "",
};

function ContactForm({
  sites,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  sites: { id: string; name: string }[];
  initial?: ContactValues;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: {
    siteId: string | null;
    firstName: string;
    lastName: string;
    position: string | null;
    department: string | null;
    email: string | null;
    mobile: string | null;
    phone: string | null;
    isPrimary: boolean;
    isDecisionMaker: boolean;
    notes: string | null;
  }) => Promise<void>;
}) {
  const [values, setValues] = useState<ContactValues>(initial ?? EMPTY);
  const set = <K extends keyof ContactValues>(key: K, value: ContactValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="c-first">First name *</Label>
          <Input
            id="c-first"
            value={values.firstName}
            onChange={(e) => set("firstName", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="c-last">Last name *</Label>
          <Input
            id="c-last"
            value={values.lastName}
            onChange={(e) => set("lastName", e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="c-site">Which plant?</Label>
          <Select id="c-site" value={values.siteId} onChange={(e) => set("siteId", e.target.value)}>
            <option value="">No particular plant</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
          {sites.length === 0 && (
            <p className="mt-0.5 text-xs text-text-muted">
              No plants recorded on this customer yet.
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="c-position">Position</Label>
          <Input
            id="c-position"
            value={values.position}
            onChange={(e) => set("position", e.target.value)}
            placeholder="Maintenance Supervisor"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="c-mobile">Mobile</Label>
          <Input
            id="c-mobile"
            value={values.mobile}
            onChange={(e) => set("mobile", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="c-email">Email</Label>
          <Input
            id="c-email"
            type="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="c-phone">Landline</Label>
          <Input id="c-phone" value={values.phone} onChange={(e) => set("phone", e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={values.isPrimary}
            onChange={(e) => set("isPrimary", e.target.checked)}
          />
          Primary contact
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={values.isDecisionMaker}
            onChange={(e) => set("isDecisionMaker", e.target.checked)}
          />
          {/* §1: AIES sells through relationships, so knowing who can say yes is load-bearing. */}
          Can approve a purchase
        </label>
      </div>

      <div>
        <Label htmlFor="c-notes">Notes</Label>
        <Textarea
          id="c-notes"
          rows={2}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Prefers Viber. Only on site Tuesdays and Thursdays."
        />
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            busy || values.firstName.trim().length === 0 || values.lastName.trim().length === 0
          }
          onClick={() =>
            void onSave({
              siteId: values.siteId || null,
              firstName: values.firstName,
              lastName: values.lastName,
              position: values.position || null,
              department: values.department || null,
              email: values.email || null,
              mobile: values.mobile || null,
              phone: values.phone || null,
              isPrimary: values.isPrimary,
              isDecisionMaker: values.isDecisionMaker,
              notes: values.notes || null,
            })
          }
        >
          {busy ? "Saving…" : "Save contact"}
        </Button>
      </div>
    </div>
  );
}
