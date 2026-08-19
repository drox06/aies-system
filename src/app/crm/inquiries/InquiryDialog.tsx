"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { INQUIRY_SOURCES, SERVICE_TYPES } from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

interface DraftItem {
  description: string;
  quantity: string;
  unit: string;
  serviceType: string;
}

const BLANK_ITEM: DraftItem = { description: "", quantity: "1", unit: "pc", serviceType: "" };

/**
 * Quick-create for an inquiry.
 *
 * §8: "Make the manual quick-create form genuinely fast: it is now the only way inquiries enter the
 * system." So `subject` is the only field that blocks submission. Everything below it can be filled
 * in later from the record page — the alternative is a salesperson on a phone call abandoning the
 * form and writing it on paper, which is the exact failure this module exists to remove.
 *
 * The line items are here rather than deferred because their `serviceType` is what selects the §4
 * requirements template, and an inquiry with no service type asks no questions at all.
 */
export function InquiryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (inquiryId: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [source, setSource] = useState<string>("phone");
  const [receivedAt, setReceivedAt] = useState("");
  const [requiredByDate, setRequiredByDate] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ ...BLANK_ITEM }]);

  // Enough for a five-person company; a combobox is session 3's problem when there are hundreds.
  const accounts = trpc.crm.listAccounts.useQuery({ pageSize: 100 }, { enabled: open });
  /**
   * The chosen customer's plants, so an inquiry records *which* one it came from.
   *
   * Asked for by the company, and §1's reason is the same: "each has plants, each plant has
   * equipment, and the same account may run several unrelated inquiries at once." A water district
   * with four treatment plants raising three inquiries is three different buildings, and without
   * this the site visit that follows has no address to go to — which is the second half of what
   * they asked for.
   *
   * Only fetched once an account is chosen, because until then there is nothing to ask about.
   */
  const sites = trpc.crm.listSites.useQuery(
    { accountId },
    { enabled: open && accountId.length > 0 },
  );
  // Not gated on `open`: an empty dropdown on first paint reads as "nobody can be assigned", and
  // this list is five rows.
  const owners = trpc.crm.inquiryOwners.useQuery();
  const create = trpc.crm.createInquiry.useMutation();

  function reset() {
    setSubject("");
    setDescription("");
    setAccountId("");
    setSiteId("");
    setSource("phone");
    setReceivedAt("");
    setRequiredByDate("");
    setEstimatedValue("");
    setOwnerId("");
    setItems([{ ...BLANK_ITEM }]);
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const inquiry = await create.mutateAsync({
        subject,
        description: description || null,
        accountId: accountId || null,
        siteId: siteId || null,
        source: source as (typeof INQUIRY_SOURCES)[number],
        // Backdating is expected: people log Friday's call on Monday, and the SLA clock has to
        // start when the customer called, not when the form was opened.
        receivedAt: receivedAt ? new Date(receivedAt) : null,
        requiredByDate: requiredByDate ? new Date(requiredByDate) : null,
        estimatedValue: estimatedValue || null,
        // Blank means "mine" — the service defaults the owner to the creator.
        ownerId: ownerId || null,
        items: items
          .filter((item) => item.description.trim().length > 0)
          .map((item) => ({
            description: item.description,
            quantity: item.quantity || "1",
            unit: item.unit || "pc",
            serviceType: (item.serviceType || null) as (typeof SERVICE_TYPES)[number] | null,
          })),
      });
      const assignee = owners.data?.find((user) => user.id === ownerId);
      toastSuccess(
        assignee ? `Logged ${inquiry.number} for ${assignee.name}` : `Logged ${inquiry.number}`,
      );
      reset();
      onOpenChange(false);
      onCreated(inquiry.id);
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">Log an inquiry</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            The number is assigned automatically. Only the subject is required — everything else can
            follow.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="inq-subject">Subject *</Label>
              <Input
                id="inq-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Replace 2 x DN100 electromagnetic flow meters"
                required
                autoFocus
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="inq-account">Account</Label>
                <Select
                  id="inq-account"
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    // A plant belongs to one customer, so changing the customer invalidates it.
                    setSiteId("");
                  }}
                >
                  <option value="">Not linked yet</option>
                  {(accounts.data?.rows ?? []).map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.code})
                    </option>
                  ))}
                </Select>
              </div>

              {/* Only when the chosen customer actually has plants. A dropdown offering one option
                  called "no particular plant" is a field to skip past on every single intake. */}
              {(sites.data ?? []).length > 0 && (
                <div>
                  <Label htmlFor="inq-site">Which plant?</Label>
                  <Select id="inq-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    <option value="">Not sure yet</option>
                    {(sites.data ?? []).map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-0.5 text-xs text-text-muted">
                    Carried onto the site inspection, so whoever goes knows where.
                  </p>
                </div>
              )}
              <div>
                <Label htmlFor="inq-source">Source</Label>
                <Select id="inq-source" value={source} onChange={(e) => setSource(e.target.value)}>
                  {INQUIRY_SOURCES.map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="inq-owner">Assign to</Label>
                <Select id="inq-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">Me — I will handle it</option>
                  {(owners.data ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                      {user.isSales ? " (sales)" : ""}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-text-muted">
                  They are notified, and theirs is the acknowledgement that starts the work.
                </p>
              </div>
              <div>
                <Label htmlFor="inq-received">Received</Label>
                <Input
                  id="inq-received"
                  type="datetime-local"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
                <p className="mt-1 text-xs text-text-muted">
                  Leave blank for now. Backdate it if the call came in earlier — the acknowledgement
                  clock runs from here.
                </p>
              </div>
              <div>
                <Label htmlFor="inq-required">Required by</Label>
                <Input
                  id="inq-required"
                  type="date"
                  value={requiredByDate}
                  onChange={(e) => setRequiredByDate(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="inq-description">What they asked for</Label>
              <Textarea
                id="inq-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="In the customer's own words, as far as possible."
              />
            </div>

            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Line items</legend>
              <p className="mb-2 text-xs text-text-muted">
                The service type on each line decides which requirements checklist the inquiry has
                to answer before it can be quoted.
              </p>
              <div className="space-y-2">
                {items.map((item, index) => (
                  <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_6rem_2rem]">
                    <Input
                      aria-label={`Line ${index + 1} description`}
                      value={item.description}
                      onChange={(e) => updateItem(index, { description: e.target.value })}
                      placeholder="Description"
                    />
                    <Input
                      aria-label={`Line ${index + 1} quantity`}
                      value={item.quantity}
                      onChange={(e) => updateItem(index, { quantity: e.target.value })}
                      inputMode="decimal"
                    />
                    <Select
                      aria-label={`Line ${index + 1} service type`}
                      value={item.serviceType}
                      onChange={(e) => updateItem(index, { serviceType: e.target.value })}
                    >
                      <option value="">Type…</option>
                      {SERVICE_TYPES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>

                    {/*
                      Removing a line somebody added by mistake.

                      Only offered when there is more than one: an inquiry with no lines at all
                      cannot select a requirements checklist, so the last line is not removable and
                      the control disappears rather than sitting there refusing.
                    */}
                    {items.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove line ${index + 1}`}
                        title="Remove this line"
                        onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setItems((current) => [...current, { ...BLANK_ITEM }])}
              >
                Add line
              </Button>
            </fieldset>

            <div>
              <Label htmlFor="inq-value">Estimated value (₱)</Label>
              <Input
                id="inq-value"
                value={estimatedValue}
                onChange={(e) => setEstimatedValue(e.target.value)}
                inputMode="decimal"
                placeholder="Rough is fine — it is for the forecast, not the quote."
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={create.isPending || subject.trim().length === 0}>
                {create.isPending ? "Logging…" : "Log inquiry"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
