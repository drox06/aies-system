"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Adding or editing a supplier (specs/03-order-procurement.md §2).
 *
 * §2 is blunt about what this form has to be: "Make the create/edit form fast and forgiving — it is
 * the only way suppliers get in." So the name is the only required field, the submit button is live
 * as soon as there is one, and every other input is optional and unmarked. A form that demands a TIN
 * before it will save is a form somebody works around by putting the order through on WhatsApp.
 *
 * Approval is **not** on this form. It is a separate decision by a smaller group under a different
 * permission, and mixing it in here would let anybody who can type a supplier in also declare it
 * approved — which is the one thing clause 8.4 exists to prevent.
 */

const CURRENCIES = ["PHP", "USD", "EUR", "JPY", "SGD", "CNY"] as const;

export function SupplierDialog({
  supplierId,
  onClose,
  onSaved,
}: {
  /** `null` to add a new one, an id to edit. */
  supplierId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = trpc.order.getSupplier.useQuery(
    { supplierId: supplierId ?? "" },
    { enabled: Boolean(supplierId) },
  );

  const [name, setName] = useState("");
  const [isPrincipal, setIsPrincipal] = useState(false);
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState<string>("PHP");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [leadTimeDaysTypical, setLeadTimeDaysTypical] = useState("");
  const [incoterm, setIncoterm] = useState("");
  const [productLines, setProductLines] = useState("");
  const [rating, setRating] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const data = existing.data;
    if (!data) return;
    setName(data.name);
    setIsPrincipal(data.isPrincipal);
    setCountry(data.country ?? "");
    setCurrency(data.currency);
    setContactName(data.contactName ?? "");
    setEmail(data.email ?? "");
    setPhone(data.phone ?? "");
    setPaymentTerms(data.paymentTerms ?? "");
    setLeadTimeDaysTypical(data.leadTimeDaysTypical ? String(data.leadTimeDaysTypical) : "");
    setIncoterm(data.incoterm ?? "");
    setProductLines(data.productLines.join(", "));
    setRating(data.rating ? String(data.rating) : "");
    setNotes(data.notes ?? "");
  }, [existing.data]);

  const upsert = trpc.order.upsertSupplier.useMutation();

  const asList = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const saved = await upsert.mutateAsync({
        supplierId,
        name,
        isPrincipal,
        country: country || null,
        currency,
        contactName: contactName || null,
        email: email || null,
        phone: phone || null,
        paymentTerms: paymentTerms || null,
        // An empty box means "unknown", which is null — not zero, which would read as "arrives the
        // same day".
        leadTimeDaysTypical: leadTimeDaysTypical ? Number(leadTimeDaysTypical) : null,
        incoterm: incoterm || null,
        productLines: asList(productLines),
        rating: rating ? Number(rating) : null,
        notes: notes || null,
      });
      toastSuccess(`${supplierId ? "Updated" : "Added"} ${saved.code} ${saved.name}`);
      onClose();
      onSaved();
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">
            {supplierId ? "Edit supplier" : "Add a supplier"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Only the name is required. Everything else can be filled in the first time it matters.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            <div>
              <Label htmlFor="sup-name">Name *</Label>
              <Input
                id="sup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="sup-country">Country</Label>
                <Input
                  id="sup-country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="sup-currency">Quotes in</Label>
                <Select
                  id="sup-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="sup-lead">Typical lead time (days)</Label>
                <Input
                  id="sup-lead"
                  value={leadTimeDaysTypical}
                  onChange={(e) => setLeadTimeDaysTypical(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="sup-lines">Product lines</Label>
              <Input
                id="sup-lines"
                value={productLines}
                onChange={(e) => setProductLines(e.target.value)}
                placeholder="Flow meters, control valves"
              />
              <p className="mt-0.5 text-xs text-text-muted">
                Comma-separated. Search on this screen looks here too.
              </p>
            </div>

            <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">Their contact</legend>
              <div>
                <Label htmlFor="sup-contact">Name</Label>
                <Input
                  id="sup-contact"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="sup-email">Email</Label>
                <Input
                  id="sup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="sup-phone">Phone</Label>
                <Input id="sup-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="sup-terms">Payment terms</Label>
                <Input
                  id="sup-terms"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  placeholder="30 days from invoice"
                />
              </div>
              <div>
                <Label htmlFor="sup-incoterm">Incoterm</Label>
                <Input
                  id="sup-incoterm"
                  value={incoterm}
                  onChange={(e) => setIncoterm(e.target.value)}
                  placeholder="FOB, CIF, DDP"
                />
              </div>
              <div>
                <Label htmlFor="sup-rating">Rating (1–5)</Label>
                <Input
                  id="sup-rating"
                  value={rating}
                  onChange={(e) => setRating(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isPrincipal}
                onChange={(e) => setIsPrincipal(e.target.checked)}
                className="size-4 rounded border-border"
              />
              <span>
                This is a principal — a manufacturer AIES represents
                <span className="block text-xs text-text-muted">
                  Appointed principals normally arrive here on their own, from the acquisition
                  pipeline. Tick this only for one that predates it.
                </span>
              </span>
            </label>

            <div>
              <Label htmlFor="sup-notes">Notes</Label>
              <Textarea
                id="sup-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={upsert.isPending || name.trim().length === 0}>
                {upsert.isPending ? "Saving…" : supplierId ? "Save changes" : "Add supplier"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
