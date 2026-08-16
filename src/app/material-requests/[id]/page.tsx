"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ITEM_TYPE_LABELS,
  MATERIAL_REQUEST_ENTITY_TYPE,
  SOURCE_LABELS,
  type ItemType,
  type Source,
} from "@/server/core/operations/material-request-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One material request (specs/04-operations-projects.md §7).
 *
 * The issue block is where §7's one hard refusal lives: an instrument that is out of calibration
 * cannot be drawn. The line says so before anybody presses anything, because a storeman finding out
 * from a server error is a storeman who tries again with a different quantity.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "info",
  partially_issued: "pending",
  issued: "approved",
  purchased: "pending",
  rejected: "cancelled",
  cancelled: "cancelled",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function MaterialRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const query = trpc.operations.getMaterialRequest.useQuery({ requestId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  if (query.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (query.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{query.error.message}</p>
      </Card>
    );
  }

  const data = query.data;
  const permissions = me.data?.permissions ?? [];
  const refresh = () => void query.refetch();

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={data.ticket.title}
        actions={
          <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
            <span className="capitalize">{human(data.status)}</span>
          </StatusBadge>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Where</h2>
              <Link
                href={`/tickets/${data.ticket.id}`}
                className="tabular mt-1 block text-sm text-blue-600 underline underline-offset-2"
              >
                {data.ticket.number}
              </Link>
              <dl className="mt-2 space-y-1 text-sm">
                <Row
                  label="Needed by"
                  value={data.neededBy ? <DateCell value={data.neededBy} /> : "—"}
                />
                <Row
                  label="Issued"
                  value={data.issuedAt ? <DateCell value={data.issuedAt} /> : "not yet"}
                />
                <Row
                  label="Return due"
                  value={data.returnDueAt ? <DateCell value={data.returnDueAt} /> : "—"}
                />
              </dl>
            </Card>

            {data.status === "purchased" && (
              <Card className="border-amber-300 bg-amber-50/50 p-4">
                <h2 className="text-sm font-semibold">Waiting on procurement</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {/* §7: "The ticket sits at material_pending until resolved." */}
                  Lines on this request need buying. Procurement has been told, and the ticket does
                  not mobilise until they arrive and are issued.
                </p>
              </Card>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted text-left">
                <tr>
                  <Th>#</Th>
                  <Th>What</Th>
                  <Th>Type</Th>
                  <Th>Source</Th>
                  <Th className="text-right">Wanted</Th>
                  <Th className="text-right">Issued</Th>
                  <Th className="text-right">Still out</Th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border last:border-0">
                    <td className="tabular px-3 py-2">{line.lineNo}</td>
                    <td className="px-3 py-2">
                      {line.description}
                      {line.calibration.blocked && (
                        // Said on the row, before anybody tries. §7 blocks this draw outright.
                        <p className="mt-0.5 text-xs text-danger">{line.calibration.message}</p>
                      )}
                      {line.notes && <p className="text-xs text-text-muted">{line.notes}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {ITEM_TYPE_LABELS[line.itemType as ItemType] ?? line.itemType}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {SOURCE_LABELS[line.source as Source] ?? line.source}
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {line.quantity} {line.unit}
                    </td>
                    <td className="tabular px-3 py-2 text-right">{line.qtyIssued}</td>
                    <td className="tabular px-3 py-2 text-right">
                      {line.outstanding > 0 ? (
                        <span className="font-medium text-amber-800">{line.outstanding}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Lifecycle data={data} permissions={permissions} onDone={refresh} />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={MATERIAL_REQUEST_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function Lifecycle({
  data,
  permissions,
  onDone,
}: {
  data: {
    id: string;
    status: string;
    lines: {
      lineNo: number;
      description: string;
      quantity: string;
      qtyIssued: string;
      outstanding: number;
    }[];
  };
  permissions: string[];
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [issueQty, setIssueQty] = useState<Record<number, string>>({});
  const [returnQty, setReturnQty] = useState<Record<number, string>>({});

  const submit = trpc.operations.submitMaterialRequest.useMutation({ onSuccess: onDone });
  const approve = trpc.operations.approveMaterialRequest.useMutation({ onSuccess: onDone });
  const issue = trpc.operations.issueMaterials.useMutation({ onSuccess: onDone });
  const back = trpc.operations.returnMaterials.useMutation({ onSuccess: onDone });

  const error = submit.error ?? approve.error ?? issue.error ?? back.error;
  const canApprove = permissions.includes("material_request.approve");
  const canIssue = permissions.includes("material_request.issue");

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">What happens next</h2>
      {error && <p className="mt-2 text-sm text-danger">{error.message}</p>}

      {data.status === "draft" && (
        <Button
          className="mt-3"
          disabled={submit.isPending}
          onClick={() => submit.mutate({ requestId: data.id })}
        >
          Send for approval
        </Button>
      )}

      {data.status === "pending_approval" &&
        (canApprove ? (
          <>
            <div className="mt-2">
              <Label htmlFor="mr-reason">Reason (required to refuse)</Label>
              <Textarea
                id="mr-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={approve.isPending}
                onClick={() => approve.mutate({ requestId: data.id, decision: "approved", reason })}
              >
                Approve it
              </Button>
              <Button
                variant="secondary"
                disabled={approve.isPending || reason.trim().length === 0}
                onClick={() => approve.mutate({ requestId: data.id, decision: "rejected", reason })}
              >
                Refuse it
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-text-muted">Waiting on approval.</p>
        ))}

      {(data.status === "approved" || data.status === "partially_issued") &&
        (canIssue ? (
          <>
            <p className="mt-1 text-xs text-text-muted">
              Issue what is actually going in the van. An instrument out of calibration will be
              refused.
            </p>
            <div className="mt-2 space-y-2">
              {data.lines.map((line) => (
                <div key={line.lineNo} className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                  <span className="text-sm">
                    {line.lineNo}. {line.description}{" "}
                    <span className="text-xs text-text-muted">
                      ({line.qtyIssued} of {line.quantity} issued)
                    </span>
                  </span>
                  <Input
                    aria-label={`Issue quantity for line ${line.lineNo}`}
                    type="number"
                    min={0}
                    step="any"
                    value={issueQty[line.lineNo] ?? ""}
                    onChange={(e) => setIssueQty({ ...issueQty, [line.lineNo]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <Button
              className="mt-3"
              disabled={issue.isPending || Object.values(issueQty).every((v) => !Number(v))}
              onClick={() =>
                issue.mutate({
                  requestId: data.id,
                  lines: Object.entries(issueQty)
                    .filter(([, v]) => Number(v) > 0)
                    .map(([lineNo, v]) => ({ lineNo: Number(lineNo), quantity: Number(v) })),
                })
              }
            >
              Issue these
            </Button>
          </>
        ) : (
          <p className="mt-2 text-sm text-text-muted">The store issues these.</p>
        ))}

      {(data.status === "issued" || data.status === "partially_issued") &&
        canIssue &&
        data.lines.some((line) => line.outstanding > 0) && (
          <>
            <h3 className="mt-5 text-sm font-semibold">Coming back</h3>
            <p className="mt-1 text-xs text-text-muted">
              {/* §7: "Tools disappear otherwise; this is universal." */}
              Anything still out stays on the custody list until it is returned or written off as
              consumed.
            </p>
            <div className="mt-2 space-y-2">
              {data.lines
                .filter((line) => line.outstanding > 0)
                .map((line) => (
                  <div key={line.lineNo} className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                    <span className="text-sm">
                      {line.lineNo}. {line.description}{" "}
                      <span className="text-xs text-text-muted">({line.outstanding} out)</span>
                    </span>
                    <Input
                      aria-label={`Returned quantity for line ${line.lineNo}`}
                      type="number"
                      min={0}
                      step="any"
                      value={returnQty[line.lineNo] ?? ""}
                      onChange={(e) =>
                        setReturnQty({ ...returnQty, [line.lineNo]: e.target.value })
                      }
                    />
                  </div>
                ))}
            </div>
            <Button
              variant="secondary"
              className="mt-3"
              disabled={back.isPending || Object.values(returnQty).every((v) => !Number(v))}
              onClick={() =>
                back.mutate({
                  requestId: data.id,
                  lines: Object.entries(returnQty)
                    .filter(([, v]) => Number(v) > 0)
                    .map(([lineNo, v]) => ({ lineNo: Number(lineNo), returned: Number(v) })),
                })
              }
            >
              Record the return
            </Button>
          </>
        )}
    </Card>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-xs font-medium text-text-muted ${className}`}>{children}</th>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
