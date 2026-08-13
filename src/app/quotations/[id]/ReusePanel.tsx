"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Label, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §9's reuse, on the quotation record.
 *
 * Three things that all serve one stated goal — the system getting easier the longer it is used:
 * duplicate this quotation for another customer, see which costs have gone stale, and add the
 * products this quotation names to a catalogue that has never required a data-entry project.
 *
 * Every one of them **asks**. §9 says "a refresh-costs prompt" and "offer to create it", and both
 * matter: a silent cost refresh would rewrite the basis of a document somebody is about to send, and
 * a catalogue that absorbed every typed line would stop being the list of things AIES actually
 * sells.
 */
export function ReusePanel({
  quotationId,
  currency,
  canSeeCost,
  editable,
}: {
  quotationId: string;
  currency: string;
  canSeeCost: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [duplicating, setDuplicating] = useState(false);
  const [accountId, setAccountId] = useState("");

  const accounts = trpc.crm.listAccounts.useQuery({ pageSize: 100 }, { enabled: duplicating });
  const stale = trpc.quotation.staleCosts.useQuery(
    { quotationId },
    { enabled: canSeeCost, retry: false },
  );
  const candidates = trpc.quotation.catalogueCandidates.useQuery(
    { quotationId },
    // `product.manage` only. The panel simply omits the section for anybody else.
    { retry: false },
  );

  const duplicate = trpc.quotation.duplicate.useMutation();
  const addProduct = trpc.quotation.addProductFromLine.useMutation();

  const staleLines = (stale.data ?? []).filter((line) => line.isStale || line.hasNewerCost);
  const newProducts = candidates.error ? [] : (candidates.data ?? []);

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Reuse</h2>

      <div className="mt-2">
        {!duplicating ? (
          <Button variant="ghost" size="sm" onClick={() => setDuplicating(true)}>
            Duplicate this quotation…
          </Button>
        ) : (
          <div className="space-y-2">
            <div>
              <Label htmlFor="dup-account">For which customer?</Label>
              <Select
                id="dup-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">The same customer</option>
                {(accounts.data?.rows ?? []).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.code})
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-text-muted">
                {/* The distinction the whole feature turns on, said plainly rather than assumed. */}
                A new quotation with its own number — not a revision of this one.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDuplicating(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={duplicate.isPending}
                onClick={async () => {
                  try {
                    const copy = await duplicate.mutateAsync({
                      sourceQuotationId: quotationId,
                      accountId: accountId || null,
                    });
                    toastSuccess(`Created ${copy.number}.`);
                    setDuplicating(false);
                    router.push(`/quotations/${copy.id}`);
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                Duplicate
              </Button>
            </div>
          </div>
        )}
      </div>

      {canSeeCost && staleLines.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Costs worth checking</h3>
          <ul className="mt-1 space-y-1.5">
            {staleLines.map((line) => (
              <li key={line.lineNo} className="text-xs">
                <span className="tabular text-text-muted">{line.lineNo}.</span> {line.description}
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-text-muted">
                  <span className="tabular">
                    costed at {formatMoney(line.currentUnitCost, currency)}
                  </span>
                  {line.hasNewerCost && line.catalogueCost && (
                    <StatusBadge tone="pending">
                      catalogue says {line.catalogueCostCurrency} {line.catalogueCost}
                    </StatusBadge>
                  )}
                  {line.lastCostAt ? (
                    <span>
                      last priced <DateCell value={line.lastCostAt} /> ({line.daysSinceCost}d)
                    </span>
                  ) : (
                    // Stronger than "three months old", and silence would read as approval.
                    <span>never priced from a supplier</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted">
            Nothing has been changed. Raise a supplier request above if a price needs confirming.
          </p>
        </div>
      )}

      {newProducts.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">New to the catalogue</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            These are on this quotation and not in the product list. Adding one keeps its cost and
            date, which is what the staleness check above reads later.
          </p>
          <ul className="mt-2 space-y-1.5">
            {newProducts.map((candidate) => (
              <li
                key={`${candidate.manufacturer}|${candidate.modelNumber}`}
                className="flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <span>
                  {candidate.manufacturer} {candidate.modelNumber}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={addProduct.isPending || !editable}
                  onClick={async () => {
                    try {
                      await addProduct.mutateAsync(candidate);
                      toastSuccess(`${candidate.modelNumber} added to the catalogue.`);
                      void utils.quotation.catalogueCandidates.invalidate({ quotationId });
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
