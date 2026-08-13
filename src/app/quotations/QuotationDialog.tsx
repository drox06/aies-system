"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  CURRENCY_LABELS,
  QUOTE_CURRENCIES,
  type QuoteCurrency,
} from "@/server/core/quotation/costing";
import { QUOTE_TYPES, quoteTypeLabel } from "@/server/core/quotation/quotation-number";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Starting a quotation by hand.
 *
 * Most quotations arrive through `inquiry.quoting_started` rather than here — §3 of module 01
 * creates the draft when an inquiry reaches `quoting`. This exists for the cases that have no
 * inquiry behind them: §9's duplicate to a different account, and a customer who rings up asking
 * for a repeat of last year's.
 *
 * The quote type is the one field that cannot be changed later without a new number, because it
 * decides which series the number comes from (`AIESLQ` or `AIESIQ`). So it is on the create form
 * and nowhere else.
 */
export function QuotationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (quotationId: string) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [quoteType, setQuoteType] = useState<(typeof QUOTE_TYPES)[number]>("local");
  const [title, setTitle] = useState("");
  const [scopeOfWork, setScopeOfWork] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [currency, setCurrency] = useState<QuoteCurrency>("PHP");
  const [templateId, setTemplateId] = useState("");

  const accounts = trpc.crm.listAccounts.useQuery({ pageSize: 100 }, { enabled: open });
  const create = trpc.quotation.create.useMutation();
  // §9's repeat scopes. Enabled with the dialog, because the list is short and an empty picker on
  // first paint reads as "there are none".
  const templates = trpc.quotation.templates.useQuery(undefined, { enabled: open });
  const fromTemplate = trpc.quotation.createFromTemplate.useMutation();

  function reset() {
    setAccountId("");
    setQuoteType("local");
    setTitle("");
    setScopeOfWork("");
    setValidUntil("");
    setCurrency("PHP");
    setTemplateId("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (templateId) {
        // A template carries the scope, the terms and the lines; everything else is the same path
        // an empty quotation takes.
        const started = await fromTemplate.mutateAsync({
          templateId,
          accountId,
          title: title || null,
        });
        toastSuccess(`Created ${started.number} from a template`);
        reset();
        onOpenChange(false);
        onCreated(started.id);
        return;
      }

      const quotation = await create.mutateAsync({
        accountId,
        quoteType,
        title,
        scopeOfWork: scopeOfWork || undefined,
        validUntil: validUntil ? new Date(validUntil) : null,
        currency,
      });
      toastSuccess(`Created ${quotation.number}`);
      reset();
      onOpenChange(false);
      onCreated(quotation.id);
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
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">New quotation</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            The number is assigned automatically from the series you choose.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            <div>
              <Label htmlFor="q-account">Customer *</Label>
              <Select
                id="q-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
              >
                <option value="">Choose an account…</option>
                {(accounts.data?.rows ?? []).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.code})
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="q-type">Series *</Label>
              <Select
                id="q-type"
                value={quoteType}
                onChange={(e) => setQuoteType(e.target.value as (typeof QUOTE_TYPES)[number])}
              >
                {QUOTE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {quoteTypeLabel(type)}
                  </option>
                ))}
              </Select>
              <p className="mt-0.5 text-xs text-text-muted">
                Local numbers run AIESLQ; indent and international run AIESIQ. This cannot be
                changed afterwards without issuing a new number.
              </p>
            </div>

            <div>
              <Label htmlFor="q-template">Start from a template</Label>
              <Select
                id="q-template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">Start empty</option>
                {(templates.data ?? []).map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} ({template.lineCount} line
                    {template.lineCount === 1 ? "" : "s"})
                  </option>
                ))}
              </Select>
              <p className="mt-0.5 text-xs text-text-muted">
                {/* Said plainly, because the fields below stop applying when one is chosen. */}A
                template brings its own scope, terms, lines and currency. The series and title below
                are ignored when you pick one.
              </p>
            </div>

            <div>
              <Label htmlFor="q-currency">Currency *</Label>
              <Select
                id="q-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as QuoteCurrency)}
              >
                {QUOTE_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {CURRENCY_LABELS[code]}
                  </option>
                ))}
              </Select>
              <p className="mt-0.5 text-xs text-text-muted">
                {/* §4's FX buffer is applied against this, so changing it later re-prices every
                    line — which is why it is asked for up front rather than buried in the builder. */}
                What the customer is quoted in. An indent order priced by a European principal is
                usually quoted in euros.
              </p>
            </div>

            <div>
              <Label htmlFor="q-title">Title *</Label>
              <Input
                id="q-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Supply of 2 × DN100 electromagnetic flow meters"
                required
              />
            </div>

            <div>
              <Label htmlFor="q-scope">Scope of work</Label>
              <Textarea
                id="q-scope"
                rows={3}
                value={scopeOfWork}
                onChange={(e) => setScopeOfWork(e.target.value)}
                placeholder="The technical narrative. This is what the customer actually reads."
              />
            </div>

            <div>
              <Label htmlFor="q-valid">Valid until</Label>
              <Input
                id="q-valid"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
              <p className="mt-0.5 text-xs text-text-muted">
                Leave blank for 30 days. A quotation with no expiry never leaves the pipeline.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  fromTemplate.isPending ||
                  !accountId ||
                  (!templateId && title.trim().length === 0)
                }
              >
                {create.isPending ? "Creating…" : "Create quotation"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
