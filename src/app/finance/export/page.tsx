"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import {
  EXPORT_DATASETS,
  EXPORT_DATASET_LABELS,
  EXPORT_PRESETS,
  type ExportDataset,
  type ExportPreset,
} from "@/server/core/finance/export-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §8's accounting export.
 *
 * ## The shape of the screen is the safety
 *
 * Choose a dataset, a layout and a period; **see what would be exported and whether it has been done
 * before**; then download and record it. Three steps rather than one button, because the middle step
 * is the entire point: §8 asks that a period not be exported twice *unnoticed*, and a one-click
 * export gives nobody the chance to notice.
 *
 * Looking is a query and recording is a mutation, so opening this screen never counts as an export.
 * If it did, the answer to "has August been done" would be yes the moment you asked.
 *
 * ## Why a repeat warns rather than refuses
 *
 * Both kinds of repeat are legitimate in the right circumstances — the accountant lost the file, or a
 * late invoice means the month genuinely needs resending — and a refusal is worked around by
 * exporting under a different filename, which loses the record entirely. So the screen says which
 * kind of repeat this is and lets a person decide.
 */

const PRESET_LABELS: Record<ExportPreset, string> = {
  generic: "Generic — AIES field names",
  quickbooks: "QuickBooks",
  xero: "Xero",
};

/** The month that just ended, which is what somebody opening this screen almost always wants. */
function lastMonth() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

export default function AccountingExportPage() {
  const defaults = lastMonth();
  const [dataset, setDataset] = useState<ExportDataset>("invoices");
  const [preset, setPreset] = useState<ExportPreset>("generic");
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);

  const history = trpc.finance.exportHistory.useQuery();

  const preview = trpc.finance.previewExport.useQuery(
    {
      dataset,
      preset,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    },
    {
      // Only once the period is complete enough to mean something. An empty end date would query
      // from the epoch to the epoch and report an alarming zero.
      enabled: periodStart !== "" && periodEnd !== "",
      retry: false,
    },
  );

  const record = trpc.finance.recordExport.useMutation({
    onSuccess: () => {
      toastSuccess("Export recorded.");
      void history.refetch();
      void preview.refetch();
    },
    onError: toastError,
  });

  function download() {
    if (!preview.data) return;
    const blob = new Blob([preview.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aies-${dataset}-${periodStart}-to-${periodEnd}-${preset}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    // Recorded on download rather than on preview: the run must describe a file somebody actually
    // has. See recordExportService for why the hash and count come from what was shown.
    record.mutate({
      dataset,
      preset,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      rowCount: preview.data.rowCount,
      contentHash: preview.data.hash,
    });
  }

  const repeat = preview.data?.repeat;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Accounting export"
        description="A period's figures in the accountant's layout, with a record of what has already been sent."
      />

      <Card className="mt-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ex-dataset">What to export</Label>
            <Select
              id="ex-dataset"
              value={dataset}
              onChange={(event) => setDataset(event.target.value as ExportDataset)}
            >
              {EXPORT_DATASETS.map((value) => (
                <option key={value} value={value}>
                  {EXPORT_DATASET_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="ex-preset">Layout</Label>
            <Select
              id="ex-preset"
              value={preset}
              onChange={(event) => setPreset(event.target.value as ExportPreset)}
            >
              {EXPORT_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {PRESET_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="ex-from">From</Label>
            <Input
              id="ex-from"
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ex-to">To</Label>
            <Input
              id="ex-to"
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
            />
          </div>
        </div>

        {preview.error && <p className="mt-3 text-sm text-danger">{preview.error.message}</p>}

        {preview.data && (
          <>
            <p className="mt-3 text-sm">
              <span className="tabular font-medium">{preview.data.rowCount}</span>{" "}
              {preview.data.rowCount === 1 ? "row" : "rows"} in this period.
            </p>

            {/*
              The warning, in the two flavours it comes in.

              An unchanged repeat would double the month in the accounts. A changed one needs the
              difference posting or the earlier entry reversing. Telling somebody which is the useful
              half — "already exported" alone leaves them guessing.
            */}
            {repeat?.seenBefore && (
              <div
                className={`mt-2 rounded-md border-2 p-2.5 text-sm ${
                  repeat.identical
                    ? "border-danger/40 bg-danger/5 text-danger"
                    : "border-amber-400 bg-amber-50 text-amber-900"
                }`}
              >
                {repeat.message}
              </div>
            )}

            <Button
              className="mt-3"
              size="sm"
              disabled={preview.data.rowCount === 0 || record.isPending}
              onClick={download}
            >
              {record.isPending ? "Recording…" : "Download and record"}
            </Button>

            {preview.data.rowCount === 0 && (
              <p className="mt-1 text-xs text-text-muted">
                Nothing to export for this period — the button is disabled rather than producing an
                empty file somebody might post.
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">Already exported</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          §8&rsquo;s record, so a period is not sent twice without somebody knowing.
        </p>

        {history.data && history.data.length === 0 && (
          <p className="mt-2 text-sm text-text-muted">Nothing has been exported yet.</p>
        )}

        {history.data && history.data.length > 0 && (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-1 font-medium">Run</th>
                <th className="py-1 font-medium">Data</th>
                <th className="py-1 font-medium">Period</th>
                <th className="py-1 text-right font-medium">Rows</th>
                <th className="py-1 font-medium">Exported</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((run) => (
                <tr key={run.id} className="border-b border-border last:border-0">
                  <td className="tabular py-1.5">{run.number}</td>
                  <td className="py-1.5">
                    {EXPORT_DATASET_LABELS[run.dataset as ExportDataset] ?? run.dataset}
                    <span className="text-xs text-text-muted"> · {run.preset}</span>
                  </td>
                  <td className="py-1.5 text-xs">
                    <DateCell value={run.periodStart} /> — <DateCell value={run.periodEnd} />
                  </td>
                  <td className="tabular py-1.5 text-right">{run.rowCount}</td>
                  <td className="py-1.5 text-xs text-text-muted">
                    <DateCell value={run.exportedAt} /> by {run.exportedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
