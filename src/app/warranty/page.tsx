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
        <h2 className="text-sm font-semibold">Installed base</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          §16&rsquo;s `Equipment`, built here because §11 has nothing to check without it. Equipment
          with no recorded window is not equipment out of warranty — it is a question nobody has
          answered.
        </p>
        <ul className="mt-2 space-y-1.5 text-sm">
          {equipment.data?.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {item.description}
                {item.serialNumber ? ` · ${item.serialNumber}` : ""}
              </span>
              <StatusBadge tone={COVERAGE_TONE[item.coverage.coverage] ?? "pending"}>
                {COVERAGE_LABELS[item.coverage.coverage]}
              </StatusBadge>
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
  equipment: {
    id: string;
    accountId: string;
    description: string;
    coverage: { coverage: Coverage; reason: string };
  }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [equipmentId, setEquipmentId] = useState("");
  const [fault, setFault] = useState("");
  const [attribution, setAttribution] = useState<Attribution>("undetermined");
  const [rootCauseCategory, setRootCauseCategory] = useState<RootCauseCategory | "">("");
  const [rootCause, setRootCause] = useState("");
  const [coverage, setCoverage] = useState<Coverage | "">("");
  const [overrideReason, setOverrideReason] = useState("");

  const raise = trpc.operations.raiseWarrantyClaim.useMutation({ onSuccess: onDone });

  const chosen = equipment.find((item) => item.id === equipmentId);
  const reading = chosen?.coverage.coverage ?? "unknown";
  const effectiveCoverage = (coverage || reading) as Coverage;
  const overriding = !!chosen && effectiveCoverage !== reading;

  const verdict = determine({ coverage: effectiveCoverage, attribution });

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
              {item.description}
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
