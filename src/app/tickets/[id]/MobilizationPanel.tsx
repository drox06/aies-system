"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { CLEARANCE_STATES } from "@/server/core/operations/mobilization-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §8's readiness check, on the ticket.
 *
 * "**Mobilization readiness check** runs automatically and shows a green/red list… `ready_to_mobilize`
 * is only reachable when all mandatory items pass."
 *
 * So it is a list, not a verdict. A single red badge saying "not ready" tells a dispatcher nothing
 * they can act on; the point of the list is that every line names the person who has to do something
 * and the thing they have to do. The three gate lines are the same verdicts §5, §6.2 and §7 show on
 * their own panels — asked here, never recomputed.
 */

const ITEM_TONE: Record<string, StatusTone> = {
  pass: "approved",
  fail: "failed",
  not_applicable: "draft",
  unknown: "pending",
};

const ITEM_LABEL: Record<string, string> = {
  pass: "ready",
  fail: "no",
  not_applicable: "n/a",
  unknown: "unknown",
};

export function MobilizationPanel({ ticketId }: { ticketId: string }) {
  const readiness = trpc.operations.mobilizationReadiness.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showPlan, setShowPlan] = useState(false);

  const canDispatch = (me.data?.permissions ?? []).includes("ticket.dispatch");

  const plan = trpc.operations.planMobilization.useMutation({
    onSuccess: () => {
      setShowPlan(false);
      void readiness.refetch();
    },
  });

  if (readiness.isPending) return null;
  if (readiness.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{readiness.error.message}</p>
      </Card>
    );
  }

  const data = readiness.data;
  const refresh = () => void readiness.refetch();

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Mobilisation</h2>
        <StatusBadge tone={data.ready ? "approved" : "failed"}>
          {data.ready ? "Ready to mobilise" : `${data.blockers.length} blocking`}
        </StatusBadge>
      </div>

      <ul className="mt-3 space-y-1.5">
        {data.items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-baseline gap-2 text-sm">
            <StatusBadge tone={ITEM_TONE[item.state] ?? "draft"}>
              {ITEM_LABEL[item.state] ?? item.state}
            </StatusBadge>
            <span className={item.mandatory ? "font-medium" : ""}>{item.label}</span>
            {!item.mandatory && item.state !== "pass" && (
              // Shown but not blocking, and said plainly so nobody chases the wrong line.
              <span className="text-xs text-text-muted">(not blocking)</span>
            )}
            <span className="w-full text-xs text-text-muted">{item.detail}</span>
          </li>
        ))}
      </ul>

      {!data.mobilizationId && canDispatch && !showPlan && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowPlan(true)}>
          Plan the mobilisation
        </Button>
      )}

      {showPlan && (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
          <PlanForm
            onSubmit={(values) => plan.mutate({ ticketId, type: "mobilization", ...values })}
            pending={plan.isPending}
            error={plan.error?.message ?? null}
            onCancel={() => setShowPlan(false)}
          />
        </div>
      )}

      {data.mobilizationId && (
        <MobilizationDetail
          mobilizationId={data.mobilizationId}
          ready={data.ready}
          canDispatch={canDispatch}
          onDone={refresh}
        />
      )}
    </Card>
  );
}

function PlanForm({
  onSubmit,
  pending,
  error,
  onCancel,
}: {
  onSubmit: (values: {
    plannedAt: Date | null;
    vehicleRef: string | null;
    driverName: string | null;
  }) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const [plannedAt, setPlannedAt] = useState("");
  const [vehicleRef, setVehicleRef] = useState("");
  const [driverName, setDriverName] = useState("");

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="mob-date">Planned for</Label>
          <Input
            id="mob-date"
            type="date"
            value={plannedAt}
            onChange={(e) => setPlannedAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="mob-vehicle">Vehicle</Label>
          <Input
            id="mob-vehicle"
            placeholder="ABC 1234"
            value={vehicleRef}
            onChange={(e) => setVehicleRef(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="mob-driver">Driver</Label>
          <Input
            id="mob-driver"
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-text-muted">
        The crew starts as whoever is assigned to the ticket. Correct it below once the row exists.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            onSubmit({
              plannedAt: plannedAt ? new Date(plannedAt) : null,
              vehicleRef: vehicleRef || null,
              driverName: driverName || null,
            })
          }
        >
          Plan it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/** The checklists and clearances that the readiness list is reading. */
function MobilizationDetail({
  mobilizationId,
  ready,
  canDispatch,
  onDone,
}: {
  mobilizationId: string;
  ready: boolean;
  canDispatch: boolean;
  onDone: () => void;
}) {
  const query = trpc.operations.getMobilization.useQuery({ mobilizationId });
  const [tools, setTools] = useState("");
  const [ppe, setPpe] = useState("");
  const [notes, setNotes] = useState("");

  const update = trpc.operations.updateMobilization.useMutation({
    onSuccess: () => {
      void query.refetch();
      onDone();
    },
  });
  const depart = trpc.operations.depart.useMutation({ onSuccess: onDone });
  const start = trpc.operations.startWork.useMutation({ onSuccess: onDone });
  const demob = trpc.operations.demobilize.useMutation({ onSuccess: onDone });

  if (query.isPending || !query.data) return null;
  const row = query.data;
  const error = update.error ?? depart.error ?? start.error ?? demob.error;

  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((label) => ({ label, checked: true }));

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">The run</h3>
        <StatusBadge tone="info">
          <span className="capitalize">{row.status.replace(/_/g, " ")}</span>
        </StatusBadge>
      </div>

      <dl className="mt-2 space-y-1 text-sm">
        <Row
          label="Planned"
          value={row.plannedAt ? <DateCell value={row.plannedAt} /> : "no date"}
        />
        <Row label="Crew" value={`${row.crewIds.length} assigned`} />
        <Row label="Vehicle" value={row.vehicleRef ?? "—"} />
        <Row
          label="Tools ticked"
          value={`${row.toolsChecklist.filter((t) => t.checked).length} of ${row.toolsChecklist.length}`}
        />
        <Row
          label="PPE confirmed"
          value={`${row.ppeChecklist.filter((t) => t.checked).length} of ${row.ppeChecklist.length}`}
        />
      </dl>

      {canDispatch && row.status !== "returned" && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="mob-gate">Gate pass</Label>
              <Select
                id="mob-gate"
                value={row.gatePassStatus}
                onChange={(e) =>
                  update.mutate({
                    mobilizationId,
                    gatePassStatus: e.target.value as (typeof CLEARANCE_STATES)[number],
                  })
                }
              >
                {CLEARANCE_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="mob-permit">Permits</Label>
              <Select
                id="mob-permit"
                value={row.permitStatus}
                onChange={(e) =>
                  update.mutate({
                    mobilizationId,
                    permitStatus: e.target.value as (typeof CLEARANCE_STATES)[number],
                  })
                }
              >
                {CLEARANCE_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={row.inductionCompleted}
              onChange={(e) =>
                update.mutate({ mobilizationId, inductionCompleted: e.target.checked })
              }
            />
            Site induction completed
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="mob-tools">Tools taken (comma separated)</Label>
              <Input
                id="mob-tools"
                placeholder="Torque wrench, gas detector"
                value={tools}
                onChange={(e) => setTools(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="mob-ppe">PPE taken</Label>
              <Input
                id="mob-ppe"
                placeholder="Harness, hard hat, gloves"
                value={ppe}
                onChange={(e) => setPpe(e.target.value)}
              />
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={update.isPending || (!tools.trim() && !ppe.trim())}
            onClick={() =>
              update.mutate({
                mobilizationId,
                ...(tools.trim() ? { toolsChecklist: list(tools) } : {}),
                ...(ppe.trim() ? { ppeChecklist: list(ppe) } : {}),
              })
            }
          >
            Save the checklists
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-danger">{error.message}</p>}

      {demob.data && (
        <p className="mt-2 text-sm text-text-muted">
          {demob.data.checklist.message}
          {demob.data.liquidationDueAt && (
            <>
              {" "}
              Cash advance liquidation is now due{" "}
              {new Date(demob.data.liquidationDueAt).toISOString().slice(0, 10)}.
            </>
          )}
        </p>
      )}

      {canDispatch && (
        <div className="mt-3 flex flex-wrap gap-2">
          {row.status === "planned" && (
            <Button
              disabled={depart.isPending || !ready}
              onClick={() => depart.mutate({ mobilizationId })}
            >
              {ready ? "Send them" : "Not ready to send"}
            </Button>
          )}
          {row.status === "departed" && (
            <Button disabled={start.isPending} onClick={() => start.mutate({ mobilizationId })}>
              They are on site
            </Button>
          )}
          {(row.status === "on_site" || row.status === "departed") && (
            <>
              <Textarea
                className="w-full"
                rows={2}
                placeholder="Anything worth recording about the return"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={demob.isPending}
                onClick={() => demob.mutate({ mobilizationId, notes: notes || null })}
              >
                Demobilise
              </Button>
            </>
          )}
        </div>
      )}

      {row.status !== "returned" && (
        <p className="mt-2 text-xs text-text-muted">
          {/* The two loops this closes, said before somebody presses it. */}
          Demobilising sets the cash advance liquidation deadline and the tool return date from the
          real return date, and reports anything issued that has not come back.
        </p>
      )}
    </div>
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
