"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Input, Label, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { PRINCIPAL_ENTITY_TYPE } from "@/server/core/crm/principal-lifecycle";

/**
 * Adding a principal prospect.
 *
 * Only the company name is required, for the same reason the inquiry form works that way: EM adds
 * these after a trade-show conversation, and a form that demands a country and a product line
 * before it will save is a form that gets skipped in favour of a note somewhere else.
 *
 * The agreement and price-list fields are deliberately *not* here — they belong to a prospect that
 * has reached `agreement_draft`, and putting them on the create form would imply they are expected
 * at first contact.
 */
export function PrincipalDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { data: session } = useSession();
  const [companyName, setCompanyName] = useState("");
  const [headOfficeAddress, setHeadOfficeAddress] = useState("");
  const [plantAddress, setPlantAddress] = useState("");
  const [callingCardFileId, setCallingCardFileId] = useState<string | null>(null);
  const [website, setWebsite] = useState("");
  const [productLines, setProductLines] = useState("");
  const [targetIndustries, setTargetIndustries] = useState("");
  const [competingBrands, setCompetingBrands] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [estimatedOpportunity, setEstimatedOpportunity] = useState("");
  const [notes, setNotes] = useState("");

  const create = trpc.crm.createPrincipal.useMutation();

  function reset() {
    for (const set of [
      setCompanyName,
      setHeadOfficeAddress,
      setPlantAddress,
      setWebsite,
      setProductLines,
      setTargetIndustries,
      setCompetingBrands,
      setContactName,
      setEmail,
      setPhone,
      setEstimatedOpportunity,
      setNotes,
    ]) {
      set("");
    }
    setCallingCardFileId(null);
  }

  /** Comma-separated in the UI, arrays on the wire. Blank entries dropped so a trailing comma does
   *  not create an empty product line. */
  const asList = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const prospect = await create.mutateAsync({
        companyName,
        headOfficeAddress: headOfficeAddress.trim() ? { line1: headOfficeAddress.trim() } : {},
        plantAddress: plantAddress.trim() ? { line1: plantAddress.trim() } : {},
        callingCardFileId,
        website: website || null,
        productLines: asList(productLines),
        targetIndustries: asList(targetIndustries),
        competingBrands: asList(competingBrands),
        contactName: contactName || null,
        email: email || null,
        phone: phone || null,
        estimatedOpportunity: estimatedOpportunity || null,
        notes: notes || null,
      });
      toastSuccess(`Added ${prospect.companyName}`);
      reset();
      onOpenChange(false);
      onSaved();
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
          <Dialog.Title className="text-base font-semibold">Add a principal prospect</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            A manufacturer AIES might represent. Only the company name is required.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            <div>
              <Label htmlFor="pp-name">Company name *</Label>
              <Input
                id="pp-name"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div>
              <Label>Calling card</Label>
              {callingCardFileId ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <a
                    href={`/api/files/${callingCardFileId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-600 hover:underline"
                  >
                    View calling card
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => setCallingCardFileId(null)}
                  >
                    Replace
                  </Button>
                </div>
              ) : (
                <FileDropzone
                  entityType={PRINCIPAL_ENTITY_TYPE}
                  // No prospect exists yet at upload time — tagged with whoever is adding it, the
                  // way `Contact.callingCardFileId` tags a stand-in id before its own record exists.
                  entityId={session?.user?.id ?? "unknown"}
                  accept="image/*"
                  multiple={false}
                  onUploaded={(files) => {
                    const uploaded = files[0];
                    if (uploaded) setCallingCardFileId(uploaded.id);
                  }}
                />
              )}
              <p className="mt-0.5 text-xs text-text-muted">
                A photo of the business card is enough to save this and formalise the rest later.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pp-head-office">Head office address</Label>
                <Input
                  id="pp-head-office"
                  value={headOfficeAddress}
                  onChange={(e) => setHeadOfficeAddress(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pp-plant">Plant address</Label>
                <Input
                  id="pp-plant"
                  value={plantAddress}
                  onChange={(e) => setPlantAddress(e.target.value)}
                  placeholder="If different from the head office"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pp-website">Website</Label>
                <Input
                  id="pp-website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="pp-lines">Product lines</Label>
              <Input
                id="pp-lines"
                value={productLines}
                onChange={(e) => setProductLines(e.target.value)}
                placeholder="Flow meters, control valves"
              />
              <p className="mt-0.5 text-xs text-text-muted">Comma-separated.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pp-industries">Target industries</Label>
                <Input
                  id="pp-industries"
                  value={targetIndustries}
                  onChange={(e) => setTargetIndustries(e.target.value)}
                  placeholder="Water, power"
                />
              </div>
              <div>
                <Label htmlFor="pp-competing">Competing brands</Label>
                <Input
                  id="pp-competing"
                  value={competingBrands}
                  onChange={(e) => setCompetingBrands(e.target.value)}
                  placeholder="Who this would displace"
                />
              </div>
            </div>

            <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">Their contact</legend>
              <div>
                <Label htmlFor="pp-contact">Name</Label>
                <Input
                  id="pp-contact"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pp-email">Email</Label>
                <Input
                  id="pp-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pp-phone">Phone</Label>
                <Input id="pp-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </fieldset>

            <div>
              <Label htmlFor="pp-opportunity">Estimated opportunity (₱ / year)</Label>
              <Input
                id="pp-opportunity"
                value={estimatedOpportunity}
                onChange={(e) => setEstimatedOpportunity(e.target.value)}
                inputMode="decimal"
              />
            </div>

            <div>
              <Label htmlFor="pp-notes">Notes</Label>
              <Textarea
                id="pp-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={create.isPending || companyName.trim().length === 0}>
                {create.isPending ? "Adding…" : "Add prospect"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
