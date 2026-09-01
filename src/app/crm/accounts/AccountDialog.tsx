"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * One dialog for create and edit.
 *
 * Two dialogs sharing a twelve-field form is how they drift — a field added to create and
 * forgotten on edit is invisible until someone cannot change it. Mode is inferred from whether an
 * `accountId` was passed.
 *
 * The §7 duplicate check runs while the form is being filled rather than on submit: the point is
 * to stop the third "Maynilad Water Svcs" existing, and a warning that arrives afterwards has
 * already failed. On edit it excludes the record being edited, or it would match itself.
 */
export function AccountDialog({
  open,
  onOpenChange,
  accountId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. */
  accountId?: string | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(accountId);
  const utils = trpc.useUtils();

  const existing = trpc.crm.getAccount.useQuery(
    { accountId: accountId ?? "" },
    { enabled: open && isEdit },
  );

  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [tin, setTin] = useState("");
  const [industry, setIndustry] = useState("");
  const [accountType, setAccountType] = useState("prospect");
  const [status, setStatus] = useState("active");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [address, setAddress] = useState("");

  // §1: "knowing who can actually say yes is load-bearing". Stored as a Contact with isPrimary,
  // not as columns on the account.
  const [contactFirst, setContactFirst] = useState("");
  const [contactLast, setContactLast] = useState("");
  const [contactPosition, setContactPosition] = useState("");
  const [contactMobile, setContactMobile] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const [debouncedName, setDebouncedName] = useState("");

  // Load the record into the form once it arrives.
  useEffect(() => {
    if (!open || !isEdit || !existing.data) return;
    const a = existing.data;
    setName(a.name);
    setLegalName(a.legalName ?? "");
    setTin(a.tin ?? "");
    setIndustry(a.industry ?? "");
    setAccountType(a.accountType);
    setStatus(a.status);
    setPhone(a.phone ?? "");
    setEmail(a.email ?? "");
    setWebsite(a.website ?? "");
    const billing = a.billingAddress as { line1?: string } | null;
    setAddress(billing?.line1 ?? "");
    const primary = a.contacts.find((c) => c.isPrimary) ?? a.contacts[0];
    setContactFirst(primary?.firstName ?? "");
    setContactLast(primary?.lastName ?? "");
    setContactPosition(primary?.position ?? "");
    setContactMobile(primary?.mobile ?? "");
    setContactEmail(primary?.email ?? "");
  }, [open, isEdit, existing.data]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedName(name.trim()), 400);
    return () => clearTimeout(t);
  }, [name]);

  const duplicates = trpc.crm.checkDuplicateAccounts.useQuery(
    {
      name: debouncedName,
      tin: tin || null,
      email: contactEmail || email || null,
      excludeAccountId: accountId ?? null,
    },
    // Two characters is not a company name; querying on it would return half the table.
    { enabled: open && debouncedName.length >= 3 },
  );

  function reset() {
    for (const set of [
      setName,
      setLegalName,
      setTin,
      setIndustry,
      setPhone,
      setEmail,
      setWebsite,
      setAddress,
      setContactFirst,
      setContactLast,
      setContactPosition,
      setContactMobile,
      setContactEmail,
      setDebouncedName,
    ]) {
      set("");
    }
    setAccountType("prospect");
    setStatus("active");
  }

  function finish() {
    reset();
    onOpenChange(false);
    onSaved();
  }

  const setContact = trpc.crm.setPrimaryContact.useMutation();

  /** The contact is saved only when a name was given — a mobile with nobody attached to it is not
   *  a contact, and creating a blank one would clutter the account. */
  async function saveContactIfNamed(id: string) {
    if (!contactFirst.trim() || !contactLast.trim()) return;
    await setContact.mutateAsync({
      accountId: id,
      firstName: contactFirst,
      lastName: contactLast,
      position: contactPosition || null,
      mobile: contactMobile || null,
      email: contactEmail || null,
    });
  }

  const create = trpc.crm.createAccount.useMutation();
  const update = trpc.crm.updateAccount.useMutation();
  const busy = create.isPending || update.isPending || setContact.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fields = {
      name,
      legalName: legalName || null,
      tin: tin || null,
      industry: industry || null,
      accountType: accountType as "customer" | "prospect" | "both",
      phone: phone || null,
      email: email || null,
      website: website || null,
      // Same JSON block the billing statement and quotation PDFs already read (`line1` is the key
      // the finance PDF specifically looks for) — this form only ever writes one line into it.
      billingAddress: address.trim() ? { line1: address.trim() } : {},
    };
    try {
      if (isEdit && accountId) {
        await update.mutateAsync({
          accountId,
          ...fields,
          status: status as "active" | "dormant" | "blacklisted",
        });
        await saveContactIfNamed(accountId);
        void utils.crm.getAccount.invalidate({ accountId });
        toastSuccess("Account updated.");
      } else {
        const account = await create.mutateAsync(fields);
        await saveContactIfNamed(account.id);
        toastSuccess(`Created ${account.code} — ${account.name}`);
      }
      finish();
    } catch (error) {
      toastError(error);
    }
  }

  const hits = duplicates.data ?? [];

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
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">
            {isEdit ? "Edit account" : "New account"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {isEdit
              ? existing.data
                ? `${existing.data.code} — changes are recorded in the activity trail.`
                : "Loading..."
              : "The account code is assigned automatically."}
          </Dialog.Description>

          <form className="mt-4 flex flex-col gap-4" onSubmit={handleSubmit}>
            <fieldset className="flex flex-col gap-3" disabled={isEdit && existing.isPending}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acc-name">Account name</Label>
                <Input
                  id="acc-name"
                  required
                  autoFocus={!isEdit}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Maynilad Water Services Inc."
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acc-legal">Registered legal name</Label>
                <Input
                  id="acc-legal"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="If it differs from the trading name"
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-tin">TIN</Label>
                  <Input
                    id="acc-tin"
                    value={tin}
                    onChange={(e) => setTin(e.target.value)}
                    placeholder="000-000-000-000"
                    className="tabular"
                  />
                </div>
                <div className="flex min-w-32 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-type">Type</Label>
                  <Select
                    id="acc-type"
                    value={accountType}
                    onChange={(e) => setAccountType(e.target.value)}
                  >
                    <option value="prospect">Prospect</option>
                    <option value="customer">Customer</option>
                    <option value="both">Both</option>
                  </Select>
                </div>
                {isEdit && (
                  <div className="flex min-w-32 flex-1 flex-col gap-1.5">
                    <Label htmlFor="acc-status">Status</Label>
                    <Select
                      id="acc-status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="active">Active</option>
                      <option value="dormant">Dormant</option>
                      <option value="blacklisted">Blacklisted</option>
                    </Select>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-industry">Industry</Label>
                  <Input
                    id="acc-industry"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    placeholder="Water utility"
                  />
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-phone">Company phone</Label>
                  <Input
                    id="acc-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(02) 8000 0000"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-email">Company email</Label>
                  <Input
                    id="acc-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="info@company.com.ph"
                  />
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="acc-website">Website</Label>
                  <Input
                    id="acc-website"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="company.com.ph"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="acc-address">Address</Label>
                <Input
                  id="acc-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="88 Kalayaan Avenue, Quezon City"
                />
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
              <legend className="sr-only">Primary contact</legend>
              <p className="text-sm font-medium">Primary contact</p>
              <p className="-mt-2 text-xs text-text-muted">
                The person you actually call. More contacts can be added from the account later.
              </p>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                  <Label htmlFor="ct-first">First name</Label>
                  <Input
                    id="ct-first"
                    value={contactFirst}
                    onChange={(e) => setContactFirst(e.target.value)}
                  />
                </div>
                <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                  <Label htmlFor="ct-last">Last name</Label>
                  <Input
                    id="ct-last"
                    value={contactLast}
                    onChange={(e) => setContactLast(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                  <Label htmlFor="ct-mobile">Mobile</Label>
                  <Input
                    id="ct-mobile"
                    value={contactMobile}
                    onChange={(e) => setContactMobile(e.target.value)}
                    placeholder="0917 000 0000"
                    className="tabular"
                  />
                </div>
                <div className="flex min-w-36 flex-1 flex-col gap-1.5">
                  <Label htmlFor="ct-position">Position</Label>
                  <Input
                    id="ct-position"
                    value={contactPosition}
                    onChange={(e) => setContactPosition(e.target.value)}
                    placeholder="Maintenance Engineer"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ct-email">Email</Label>
                <Input
                  id="ct-email"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="engineer@company.com.ph"
                />
              </div>
            </fieldset>

            {hits.length > 0 && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                <p className="font-medium">
                  {hits.length === 1
                    ? "A similar account already exists"
                    : "Similar accounts exist"}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {hits.map((hit) => (
                    <li key={hit.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="tabular text-text-muted">{hit.code}</span>
                      <span className="font-medium">{hit.name}</span>
                      <span className="text-xs text-text-muted">
                        {/* Naming the signal is what makes the warning actionable — a matching TIN
                            is near-proof, a similar name is a judgement call. */}
                        {hit.reasons
                          .map((r) =>
                            r === "tin"
                              ? "same TIN"
                              : r === "email_domain"
                                ? "same email domain"
                                : "similar name",
                          )
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-text-muted">
                  You can still save — several unrelated companies share similar names.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="secondary" disabled={busy}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={busy || name.trim().length === 0}>
                {busy ? "Saving..." : isEdit ? "Save changes" : "Create account"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
