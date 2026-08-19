"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ATTRIBUTION,
  ATTRIBUTION_LABELS,
  COVERAGE,
  COVERAGE_LABELS,
  ROOT_CAUSE_CATEGORIES,
  ROOT_CAUSE_LABELS,
  determine,
  type Attribution,
  type Coverage,
  type RootCauseCategory,
} from "@/server/core/operations/warranty-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §11's warranty gate.
 *
 * The screen's job is to keep the two questions apart. §11 lists three outcomes and it is tempting
 * to draw them as one dropdown — which would quietly lose the case that matters most: our fault,
 * out of warranty, still ours to fix. So coverage and attribution are asked separately, and the
 * consequence of the pair is shown before anybody saves.
 */

const COVERAGE_TONE: Record<Coverage, StatusTone> = {
  in_warranty: "approved",
  out_of_warranty: "failed",
  unknown: "pending",
};

export default function WarrantyPage() {
  const claims = trpc.operations.listWarrantyClaims.useQuery({});
  const report = trpc.operations.warrantyReport.useQuery({});
  const equipment = trpc.operations.listEquipment.useQuery({});
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManageEquipment = (me.data?.permissions ?? []).includes("equipment.manage");
  const refreshEquipment = () => void equipment.refetch();

  const canDetermine = (me.data?.permissions ?? []).includes("warranty.determine");
  const [raising, setRaising] = useState(false);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Warranty"
        description="§11's callback lane: work already commissioned that has come back, and who pays for it."
      />

      {claims.data && claims.data.awaitingDetermination > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">
            {claims.data.awaitingDetermination} claim(s) nobody has answered.
          </p>
          <p className="mt-0.5 text-sm text-amber-900">
            Each one is a customer waiting to be told whether they are paying.
          </p>
        </Card>
      )}

      {report.data && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">What warranty work is costing</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            §11: warranty cost that nobody totals is warranty cost that never gets fixed. The
            AIES-caused share is the part the company could have avoided.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Metric label="Claims" value={String(report.data.total)} />
            <Metric
              label="AIES caused"
              value={
                report.data.aiesCausedPct === null
                  ? "—"
                  : `${report.data.aiesCausedCount} (${report.data.aiesCausedPct}%)`
              }
            />
            <Metric
              label="Cost"
              value={report.data.totalCost > 0 ? String(report.data.totalCost) : "not yet totalled"}
            />
          </div>
          {report.data.totalCost === 0 && report.data.total > 0 && (
            <p className="mt-2 text-xs text-text-muted">
              Cost arrives with §16&rsquo;s timesheets and field expenses. The shape is here so the
              report is not waiting on a module that has not been built.
            </p>
          )}

          {report.data.byCause.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-text-muted">By root cause</h3>
              <ul className="mt-1 space-y-0.5 text-sm">
                {report.data.byCause.map((entry) => (
                  <li key={entry.category} className="flex justify-between gap-4">
                    <span>
                      {ROOT_CAUSE_LABELS[entry.category as RootCauseCategory] ?? entry.category}
                    </span>
                    <span className="tabular text-text-muted">{entry.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.data.byProduct.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-text-muted">By product</h3>
              <ul className="mt-1 space-y-0.5 text-sm">
                {report.data.byProduct.map((entry) => (
                  <li key={entry.modelNumber} className="flex justify-between gap-4">
                    <span>{entry.modelNumber}</span>
                    <span className="tabular text-text-muted">{entry.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {canDetermine && (
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Claims</h2>
            {!raising && (
              <Button size="sm" variant="secondary" onClick={() => setRaising(true)}>
                Record a callback
              </Button>
            )}
          </div>

          {raising && (
            <RaiseClaimForm
              equipment={equipment.data ?? []}
              onDone={() => {
                setRaising(false);
                void claims.refetch();
                void report.refetch();
              }}
              onCancel={() => setRaising(false)}
            />
          )}
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Recorded claims</h2>
        {claims.isPending && <p className="mt-1 text-sm text-text-muted">Loading…</p>}
        {claims.data?.rows.length === 0 && (
          <p className="mt-1 text-sm text-text-muted">
            Nothing has come back yet. §11&rsquo;s gate passed with no claim is the normal case, and
            it needs no record — commissioning already moved those tickets to close-out.
          </p>
        )}
        <ul className="mt-2 space-y-2 text-sm">
          {claims.data?.rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="tabular font-medium">{row.number}</span>
                <span className="flex items-center gap-2 text-xs text-text-muted">
                  <StatusBadge tone={COVERAGE_TONE[row.coverage as Coverage] ?? "pending"}>
                    {COVERAGE_LABELS[row.coverage as Coverage] ?? row.coverage}
                  </StatusBadge>
                  <StatusBadge tone={row.billable ? "failed" : "approved"}>
                    {row.billable ? "Chargeable" : "Not billable"}
                  </StatusBadge>
                  <DateCell value={row.reportedAt} />
                </span>
              </div>
              <p className="mt-1">{row.faultDescription}</p>
              {/* §11 reports warranty by count, cost and root cause. This is the cost half. */}
              {canDetermine && (
                <div className="mt-1">
                  <ClaimCost claim={row} onDone={() => void claims.refetch()} />
                </div>
              )}
              <p className="mt-0.5 text-xs text-text-muted">
                {ATTRIBUTION_LABELS[row.attribution as Attribution] ?? row.attribution}
                {row.rootCauseCategory
                  ? ` · ${ROOT_CAUSE_LABELS[row.rootCauseCategory as RootCauseCategory] ?? row.rootCauseCategory}`
                  : ""}
              </p>
              {row.ncrRequired && (
                <p className="mt-0.5 text-xs text-danger">
                  A defect the company caused. §11 makes this an NCR when module 08 exists — the
                  obligation is on the record until then.
                </p>
              )}
              {row.coverageOverrideReason && (
                <p className="mt-0.5 text-xs text-amber-800">
                  Coverage overridden: {row.coverageOverrideReason}
                </p>
              )}
              {row.status === "open" && (
                <p className="mt-0.5 text-xs text-amber-800">Nobody has answered this one yet.</p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Installed base — equipment on customer sites</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          §16&rsquo;s `Equipment`, built here because §11 has nothing to check without it. Equipment
          with no recorded window is not equipment out of warranty — it is a question nobody has
          answered.
        </p>
        <ul className="mt-2 space-y-1.5 text-sm">
          {equipment.data?.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {/*
                  The tag number leads, because it is how the plant refers to the thing.

                  This listed the description and the serial only, so an instrument the customer
                  calls FT-3011 appeared as "DN80 electromagnetic flowmeter, syrup line" and could
                  not be found by the name anybody uses. A tag is what is on the loop diagram, on the
                  P&ID, and on the phone when they ring to say it is reading low; the serial is what
                  the manufacturer calls it, and matters only once you already have the right row.
                */}
                {item.tagNumber && <span className="tabular font-medium">{item.tagNumber}</span>}
                {item.tagNumber ? " · " : ""}
                {item.description}
                {item.serialNumber ? (
                  <span className="text-text-muted">{` · ${item.serialNumber}`}</span>
                ) : null}
                {item.location ? (
                  <span className="block text-xs text-text-muted">{item.location}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2">
                {/*
                  The window, beside the badge that was computed from it.

                  A coverage badge on its own is a conclusion with its evidence hidden, and the
                  company could not check it: "I don't see dates, so I can't visually check if in
                  warranty or out." A badge somebody cannot audit is a badge they have to trust, and
                  this one decides who pays.
                */}
                <span className="text-xs text-text-muted">{warrantyWindow(item)}</span>
                <StatusBadge tone={COVERAGE_TONE[item.coverage.coverage] ?? "pending"}>
                  {COVERAGE_LABELS[item.coverage.coverage]}
                </StatusBadge>
                {canManageEquipment && <EditWarrantyDates item={item} onDone={refreshEquipment} />}
              </span>
            </li>
          ))}
        </ul>
        {equipment.data?.length === 0 && (
          <p className="mt-1 text-sm text-text-muted">Nothing in the installed base yet.</p>
        )}
      </Card>
    </div>
  );
}

/**
 * The warranty window in words, and how long is left of it.
 *
 * Days rather than only dates, because "expires 14 Sep 2027" needs mental arithmetic and "307 days
 * left" does not — and the question being asked is always *is this covered now*. The dates come too,
 * because the arithmetic is what somebody will want to check when a customer disputes it.
 *
 * Equipment with no recorded window says so plainly. §11 is explicit that this is not the same as
 * out of warranty: it is a question nobody has answered, and answering it is what the edit control
 * beside it is for.
 */
function warrantyWindow(item: { warrantyStart: Date | null; warrantyEnd: Date | null }): string {
  if (!item.warrantyEnd) return "no window recorded";

  const end = new Date(item.warrantyEnd);
  const days = Math.round((end.getTime() - Date.now()) / 86_400_000);
  const until = end.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  if (days < 0) return `expired ${-days} d ago · ${until}`;
  return `${days} d left · to ${until}`;
}

/**
 * Correcting a warranty window.
 *
 * `upsertEquipmentService` existed with no screen, so a wrong or missing warranty date could not be
 * put right from anywhere — which made the coverage badge unarguable in the worst sense. Asked for
 * by the company on 2026-08-20: "where to edit warranty date?"
 *
 * Deliberately only the two dates. This is a correction control, not an equipment editor: the
 * description, serial and tag are how the record is *identified*, and quietly changing those from a
 * warranty screen is how one instrument's history becomes another's. A fuller editor belongs with
 * §16's installed base when it gets its own screen.
 *
 * A claim already raised keeps the verdict it was given — see `raiseWarrantyClaimService`, which
 * stores the determination rather than recomputing it. Correcting a date here fixes what happens
 * next, and does not rewrite what a customer was already told.
 */
function EditWarrantyDates({
  item,
  onDone,
}: {
  item: {
    id: string;
    accountId: string;
    description: string;
    warrantyStart: Date | null;
    warrantyEnd: Date | null;
  };
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const asInput = (value: Date | null) => (value ? new Date(value).toISOString().slice(0, 10) : "");
  const [start, setStart] = useState(asInput(item.warrantyStart));
  const [end, setEnd] = useState(asInput(item.warrantyEnd));

  const save = trpc.operations.upsertEquipment.useMutation({
    onSuccess: () => {
      toastSuccess("Warranty window updated.");
      setOpen(false);
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Dates
      </Button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border p-2.5">
      <p className="text-xs font-medium">{item.description}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor={`ws-${item.id}`}>Warranty starts</Label>
          <Input
            id={`ws-${item.id}`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`we-${item.id}`}>Warranty ends</Label>
          <Input
            id={`we-${item.id}`}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              id: item.id,
              accountId: item.accountId,
              description: item.description,
              warrantyStart: start ? new Date(start) : null,
              warrantyEnd: end ? new Date(end) : null,
            })
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What the rectification cost.
 *
 * §11 reports warranty by count, cost and root cause. The cost half had no column and no control, so
 * the figure read "not yet totalled" on every claim and always would have — a report nobody can feed
 * is a report nobody reads.
 *
 * Empty means *nobody has costed this yet*, which the summary treats differently from zero. Typing 0
 * deliberately is allowed and means it cost nothing.
 */
function ClaimCost({
  claim,
  onDone,
}: {
  claim: { id: string; number: string; cost: string | number | null };
  onDone: () => void;
}) {
  const [value, setValue] = useState(claim.cost === null ? "" : String(claim.cost));
  const save = trpc.operations.recordWarrantyCost.useMutation({
    onSuccess: () => {
      toastSuccess(`Cost recorded on ${claim.number}.`);
      onDone();
    },
    onError: toastError,
  });

  const dirty = (claim.cost === null ? "" : String(claim.cost)) !== value;

  return (
    <span className="flex items-center gap-1">
      <Label htmlFor={`wc-cost-${claim.id}`} className="text-xs text-text-muted">
        Cost
      </Label>
      <Input
        id={`wc-cost-${claim.id}`}
        type="number"
        min={0}
        step="0.01"
        className="w-28 text-right"
        placeholder="not costed"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {dirty && (
        <Button
          size="sm"
          variant="secondary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({ id: claim.id, cost: value.trim() === "" ? null : Number(value) })
          }
        >
          Save
        </Button>
      )}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2.5">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}

function RaiseClaimForm({
  equipment,
  onDone,
  onCancel,
}: {
  /*
    Restated by hand, and it drifted — the list above started showing tag and serial while this
    still declared neither, so widening the display broke the build. Kept narrow rather than
    inferred because this form needs only these fields, but the lesson is the usual one: a hand-copy
    of a server shape is a second source of truth.
  */
  equipment: {
    id: string;
    accountId: string;
    description: string;
    tagNumber: string | null;
    serialNumber: string | null;
    coverage: { coverage: Coverage; reason: string };
  }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [equipmentId, setEquipmentId] = useState("");
  const [fault, setFault] = useState("");
  const [attribution, setAttribution] = useState<Attribution>("undetermined");
  const [manufacturerCovers, setManufacturerCovers] = useState(false);
  const [manufacturerCoversReason, setManufacturerCoversReason] = useState("");
  const [rootCauseCategory, setRootCauseCategory] = useState<RootCauseCategory | "">("");
  const [rootCause, setRootCause] = useState("");
  const [coverage, setCoverage] = useState<Coverage | "">("");
  const [overrideReason, setOverrideReason] = useState("");

  const raise = trpc.operations.raiseWarrantyClaim.useMutation({ onSuccess: onDone });

  const chosen = equipment.find((item) => item.id === equipmentId);
  const reading = chosen?.coverage.coverage ?? "unknown";
  const effectiveCoverage = (coverage || reading) as Coverage;
  const overriding = !!chosen && effectiveCoverage !== reading;

  const verdict = determine({ coverage: effectiveCoverage, attribution, manufacturerCovers });

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <div>
        <Label htmlFor="wc-equipment">Equipment</Label>
        <Select
          id="wc-equipment"
          value={equipmentId}
          onChange={(e) => {
            setEquipmentId(e.target.value);
            setCoverage("");
          }}
        >
          <option value="">Not identified</option>
          {equipment.map((item) => (
            <option key={item.id} value={item.id}>
              {/* Tag first here too — somebody raising a claim is holding a tag, not a datasheet. */}
              {item.tagNumber ? `${item.tagNumber} · ` : ""}
              {item.description}
              {item.serialNumber ? ` · ${item.serialNumber}` : ""}
            </option>
          ))}
        </Select>
        {chosen && <p className="mt-0.5 text-xs text-text-muted">{chosen.coverage.reason}</p>}
      </div>

      <div>
        <Label htmlFor="wc-fault">What has failed</Label>
        <Textarea
          id="wc-fault"
          rows={2}
          placeholder="Transmitter reads zero on start-up"
          value={fault}
          onChange={(e) => setFault(e.target.value)}
        />
      </div>

      {/*
        Two questions, deliberately not one. §11 makes an AIES-caused defect non-billable and a
        quality event whether or not the window has closed — a single dropdown would lose that.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="wc-coverage">Covered?</Label>
          <Select
            id="wc-coverage"
            value={effectiveCoverage}
            onChange={(e) => setCoverage(e.target.value as Coverage)}
          >
            {COVERAGE.map((value) => (
              <option key={value} value={value}>
                {COVERAGE_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="wc-attribution">Whose fault?</Label>
          <Select
            id="wc-attribution"
            value={attribution}
            onChange={(e) => setAttribution(e.target.value as Attribution)}
          >
            {ATTRIBUTION.map((value) => (
              <option key={value} value={value}>
                {ATTRIBUTION_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {overriding && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">
            This overrides what the equipment record says.
          </p>
          <div className="mt-2">
            <Label htmlFor="wc-override">Why</Label>
            <Textarea
              id="wc-override"
              rows={2}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          </div>
        </div>
      )}

      {attribution === "aies_caused" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="wc-cause">Root cause</Label>
            <Select
              id="wc-cause"
              value={rootCauseCategory}
              onChange={(e) => setRootCauseCategory(e.target.value as RootCauseCategory)}
            >
              <option value="">Choose one</option>
              {ROOT_CAUSE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {ROOT_CAUSE_LABELS[value]}
                </option>
              ))}
            </Select>
            <p className="mt-0.5 text-xs text-text-muted">
              Required when it is ours. &ldquo;Ours&rdquo; with no cause tells nobody what to stop
              doing.
            </p>
          </div>
          <div>
            <Label htmlFor="wc-cause-detail">What happened</Label>
            <Input
              id="wc-cause-detail"
              value={rootCause}
              onChange={(e) => setRootCause(e.target.value)}
            />
          </div>
        </div>
      )}

      {/*
        The exception to "misuse is chargeable", offered only where it applies.

        Shown when the equipment is in warranty and somebody other than AIES caused the fault — the
        one case where the answer turns on the principal's terms rather than on the dates. Hiding it
        the rest of the time keeps it from becoming a box people tick out of habit, which is exactly
        what would hollow the rule out.

        It demands a reason. "The manufacturer covers it" with nothing behind it is the claim, not
        the evidence, and the next person deciding a similar claim needs to know which it was.
      */}
      {effectiveCoverage === "in_warranty" &&
        (attribution === "customer_caused" || attribution === "third_party") && (
          <div className="rounded-md border border-border p-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={manufacturerCovers}
                onChange={(e) => setManufacturerCovers(e.target.checked)}
              />
              <span>
                The manufacturer&rsquo;s terms cover this anyway
                <span className="mt-0.5 block text-xs text-text-muted">
                  Misuse is chargeable by default — a warranty covers the equipment being defective,
                  not the equipment being broken. Tick this only if their terms genuinely cover it,
                  or AIES is choosing to honour it commercially.
                </span>
              </span>
            </label>
            {manufacturerCovers && (
              <div className="mt-2">
                <Label htmlFor="wc-mfr-reason">Why it is covered</Label>
                <Input
                  id="wc-mfr-reason"
                  value={manufacturerCoversReason}
                  placeholder="E+H covers accidental damage in year one under the extended terms."
                  onChange={(e) => setManufacturerCoversReason(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

      <div className="rounded-md border border-border bg-surface-muted p-2.5 text-sm">
        <strong>{verdict.billable ? "Chargeable" : "Not billable"}</strong>
        {verdict.ncrRequired ? " · raises an NCR" : ""}
        {verdict.referToSales ? " · goes to sales to quote" : ""}
        {verdict.raisesTicket ? " · raises a warranty ticket" : ""}
        <p className="mt-1 text-xs text-text-muted">{verdict.reason}</p>
      </div>

      {raise.error && <p className="text-sm text-danger">{raise.error.message}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            raise.isPending ||
            !fault.trim() ||
            !chosen ||
            (overriding && !overrideReason.trim()) ||
            (attribution === "aies_caused" && !rootCauseCategory)
          }
          onClick={() =>
            raise.mutate({
              accountId: chosen!.accountId,
              equipmentId: equipmentId || null,
              faultDescription: fault,
              coverage: effectiveCoverage,
              attribution,
              rootCause: rootCause || null,
              rootCauseCategory: rootCauseCategory || null,
              coverageOverrideReason: overrideReason || null,
              manufacturerCovers,
              manufacturerCoversReason: manufacturerCovers
                ? manufacturerCoversReason.trim() || null
                : null,
            })
          }
        >
          Record it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
