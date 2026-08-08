"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/01-crm-inquiry.md §7's duplicate check runs *while* the form is being filled, not on
 * submit. The point is to stop the third "Maynilad Water Svcs" being created, and a warning that
 * arrives after the record exists has already failed.
 */
export function CreateAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [tin, setTin] = useState("");
  const [email, setEmail] = useState("");
  const [industry, setIndustry] = useState("");
  const [accountType, setAccountType] = useState<"customer" | "prospect" | "both">("prospect");
  const [debouncedName, setDebouncedName] = useState("");

  // Debounced so the check does not fire on every keystroke of a long company name.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedName(name.trim()), 400);
    return () => clearTimeout(t);
  }, [name]);

  const duplicates = trpc.crm.checkDuplicateAccounts.useQuery(
    { name: debouncedName, tin: tin || null, email: email || null },
    // Two characters is not a company name; querying on it would return half the table.
    { enabled: open && debouncedName.length >= 3 },
  );

  const create = trpc.crm.createAccount.useMutation({
    onSuccess: (account) => {
      toastSuccess(`Created ${account.code} — ${account.name}`);
      reset();
      onOpenChange(false);
      onCreated();
    },
    onError: toastError,
  });

  function reset() {
    setName("");
    setTin("");
    setEmail("");
    setIndustry("");
    setAccountType("prospect");
    setDebouncedName("");
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
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">New account</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            The account code is assigned automatically.
          </Dialog.Description>

          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({
                name,
                tin: tin || null,
                email: email || null,
                industry: industry || null,
                accountType,
              });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-name">Account name</Label>
              <Input
                id="acc-name"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maynilad Water Services Inc."
              />
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="acc-tin">TIN</Label>
                <Input
                  id="acc-tin"
                  value={tin}
                  onChange={(e) => setTin(e.target.value)}
                  placeholder="000-000-000-000"
                  className="tabular"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="acc-type">Type</Label>
                <Select
                  id="acc-type"
                  value={accountType}
                  onChange={(e) =>
                    setAccountType(e.target.value as "customer" | "prospect" | "both")
                  }
                >
                  <option value="prospect">Prospect</option>
                  <option value="customer">Customer</option>
                  <option value="both">Both</option>
                </Select>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="acc-email">Email</Label>
                <Input
                  id="acc-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="procurement@company.com.ph"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="acc-industry">Industry</Label>
                <Input
                  id="acc-industry"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="Water utility"
                />
              </div>
            </div>

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
                        {/* Naming the signal is what makes the warning actionable — a matching
                            TIN is near-proof, a similar name is a judgement call. */}
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
                  You can still create this account — several unrelated companies share similar
                  names.
                </p>
              </div>
            )}

            <div className="mt-2 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="secondary" disabled={create.isPending}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
                {create.isPending ? "Creating..." : "Create account"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
