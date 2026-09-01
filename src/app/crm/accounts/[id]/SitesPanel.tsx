"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
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
export function SitesPanel({ accountId }: { accountId: string }) {
  const utils = trpc.useUtils();
  const sites = trpc.crm.listSites.useQuery({ accountId });
  const upsert = trpc.crm.upsertSite.useMutation();
  const upsertContact = trpc.crm.upsertContact.useMutation();
  const remove = trpc.crm.deleteSite.useMutation();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = sites.data ?? [];
  const refresh = () => {
    void utils.crm.listSites.invalidate({ accountId });
    void utils.crm.getAccount.invalidate({ accountId });
    void utils.crm.listContacts.invalidate({ accountId });
  };

  /**
   * A plant, its address, and its contact all save in one action from the person's side, but the
   * contact needs a real `siteId` to belong to (§1: "who do I ring about Plant 2") and a new plant
   * has no id until it exists — so a brand-new plant with a contact takes three calls: create the
   * plant, create the contact against it, then attach the contact back as the plant's main one.
   * Editing an existing plant already has the id, so it collapses to two.
   */
  async function savePlantAndContact(
    site: { name: string; address: SiteAddress; accessNotes: string | null; siteId?: string },
    contact: ContactFields | null,
  ) {
    const firstSave = await upsert.mutateAsync({
      siteId: site.siteId,
      accountId,
      name: site.name,
      address: site.address,
      accessNotes: site.accessNotes,
      // A brand-new plant has no id yet for a contact to belong to, so this starts unset; on an
      // existing plant, no contact fields filled in means "no contact", cleared explicitly. Either
      // way it is set correctly below once (and if) a contact is saved.
      contactId: null,
    });

    if (!contact) return;

    const saved = await upsertContact.mutateAsync({
      accountId,
      siteId: firstSave.id,
      contactId: contact.contactId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      position: contact.position || null,
      mobile: contact.mobile || null,
      email: contact.email || null,
    });

    // The one call that cannot be avoided: the plant needs the contact's id, and the contact
    // needed the plant's id first, so attaching them back together is always a second write.
    await upsert.mutateAsync({
      siteId: firstSave.id,
      accountId,
      name: site.name,
      address: site.address,
      accessNotes: site.accessNotes,
      contactId: saved.id,
    });
  }

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
          busy={upsert.isPending || upsertContact.isPending}
          onCancel={() => setAdding(false)}
          onSave={async (site, contact) => {
            try {
              await savePlantAndContact(site, contact);
              toastSuccess(`Added ${site.name}.`);
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
                  busy={upsert.isPending || upsertContact.isPending}
                  initial={{
                    name: site.name,
                    address: (site.address as SiteAddress)?.line1 ?? "",
                    accessNotes: site.accessNotes ?? "",
                    contact: site.contacts.find((c) => c.id === site.contactId) ?? null,
                  }}
                  onCancel={() => setEditing(null)}
                  onSave={async (values, contact) => {
                    try {
                      await savePlantAndContact({ ...values, siteId: site.id }, contact);
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
                  {(site.address as SiteAddress)?.line1 && (
                    <span className="text-xs text-text-muted">
                      {(site.address as SiteAddress).line1}
                    </span>
                  )}
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

/** The shape written into `Site.address` and `CustomerAccount.billingAddress` alike — see
 *  `addressLine()` in the quotation and order PDF renderers, which flatten whichever of these
 *  string values are present, and `addressLines()` in the finance renderer, which specifically
 *  looks for `line1`. */
export interface SiteAddress {
  line1?: string;
}

interface ContactFields {
  contactId: string | null;
  firstName: string;
  lastName: string;
  position: string;
  mobile: string;
  email: string;
}

interface SiteValues {
  name: string;
  address: string;
  accessNotes: string;
  contact: {
    id: string;
    firstName: string;
    lastName: string;
    position: string | null;
    mobile: string | null;
    email: string | null;
  } | null;
}

const EMPTY_SITE: SiteValues = { name: "", address: "", accessNotes: "", contact: null };

function SiteForm({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial?: SiteValues;
  busy: boolean;
  onCancel: () => void;
  onSave: (
    site: { name: string; address: SiteAddress; accessNotes: string | null },
    contact: ContactFields | null,
  ) => Promise<void>;
}) {
  const [values, setValues] = useState<SiteValues>(initial ?? EMPTY_SITE);
  const c = initial?.contact;
  const [contactId] = useState(c?.id ?? null);
  const [contactFirst, setContactFirst] = useState(c?.firstName ?? "");
  const [contactLast, setContactLast] = useState(c?.lastName ?? "");
  const [contactPosition, setContactPosition] = useState(c?.position ?? "");
  const [contactMobile, setContactMobile] = useState(c?.mobile ?? "");
  const [contactEmail, setContactEmail] = useState(c?.email ?? "");

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
          <Label htmlFor="s-address">Address</Label>
          <Input
            id="s-address"
            value={values.address}
            onChange={(e) => setValues((v) => ({ ...v, address: e.target.value }))}
            placeholder="Where a delivery driver should actually go"
          />
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

      <fieldset className="flex flex-col gap-3 border-t border-border pt-3">
        <legend className="sr-only">Contact at this plant</legend>
        <p className="text-sm font-medium">Add a contact for this plant</p>
        <p className="-mt-2 text-xs text-text-muted">
          Who to actually ring when work is happening here. Leave blank if nobody is nominated yet.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="s-c-first">First name</Label>
            <Input
              id="s-c-first"
              value={contactFirst}
              onChange={(e) => setContactFirst(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="s-c-last">Last name</Label>
            <Input
              id="s-c-last"
              value={contactLast}
              onChange={(e) => setContactLast(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="s-c-position">Position</Label>
            <Input
              id="s-c-position"
              value={contactPosition}
              onChange={(e) => setContactPosition(e.target.value)}
              placeholder="Maintenance Engineer"
            />
          </div>
          <div>
            <Label htmlFor="s-c-mobile">Mobile</Label>
            <Input
              id="s-c-mobile"
              value={contactMobile}
              onChange={(e) => setContactMobile(e.target.value)}
              placeholder="0917 000 0000"
              className="tabular"
            />
          </div>
          <div>
            <Label htmlFor="s-c-email">Email</Label>
            <Input
              id="s-c-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || values.name.trim().length === 0}
          onClick={() => {
            const named = contactFirst.trim().length > 0 && contactLast.trim().length > 0;
            void onSave(
              {
                name: values.name,
                address: values.address.trim() ? { line1: values.address.trim() } : {},
                accessNotes: values.accessNotes || null,
              },
              named
                ? {
                    contactId,
                    firstName: contactFirst,
                    lastName: contactLast,
                    position: contactPosition,
                    mobile: contactMobile,
                    email: contactEmail,
                  }
                : null,
            );
          }}
        >
          {busy ? "Saving…" : "Save plant"}
        </Button>
      </div>
    </div>
  );
}
