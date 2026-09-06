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
 * and the thing they have to do. The gate lines are the same verdicts module 03, §5, §6.2 and §7
 * show on their own screens — asked here, never recomputed.
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

/**
 * Where an unmet gate is actually fixed.
 *
 * §8's readiness panel computes its answer from other people's records, which is right — but it left
 * the reader holding a red badge and no idea which screen changes it. The company put it plainly:
 * if it is not ready, it should be clickable and take you to the place that fixes it.
 *
 * Two of these are on this very panel, so they scroll rather than navigate; the rest are elsewhere.
 * `null` means the gate is cleared by editing the mobilisation row below, which is already in view.
 */
type Destination =
  | { kind: "panel"; panel: string }
  | { kind: "here"; anchor: string }
  | { kind: "record" }
  | { kind: "order" };

/**
 * Where each readiness item is answered.
 *
 * §8's readiness panel computes its answer from other people's records, which is right — but it left
 * the reader holding a red badge and no idea which screen changes it. The company put it plainly: if
 * it is not ready, the **title** should be clickable and take you to the place that fixes it. Not a
 * separate "open the materials panel" link beside the title, which is what this had first: two
 * things to read where one would do, and the one people reach for is the words naming the problem.
 *
 * Four kinds of destination, because there are four kinds of answer:
 *
 * - `panel` — a different panel on this same ticket. Opens it and scrolls.
 * - `here` — a field on the mobilisation row further down this panel. Scrolls, no reload.
 * - `record` — another module's screen entirely. "Customer contact confirmed" is read from the
 *   site's contact list (see mobilization-service), and sites live on the account record, so that
 *   is where this one goes.
 * - `order` — docs/DECISIONS.md #186's downpayment gate. The evidence is the sales order's own
 *   `Finance` panel, not anything on this ticket — a ticket can outlive the order's billing plan
 *   changing underneath it, so this links out rather than duplicating what Billing already shows.
 */
const GATE_DESTINATION: Record<string, Destination> = {
  downpayment: { kind: "order" },
  cash_advance: { kind: "panel", panel: "cash-advance" },
  methodology: { kind: "panel", panel: "methodology" },
  materials: { kind: "panel", panel: "materials" },
  crew: { kind: "here", anchor: "mob-crew" },
  // Competence is a property of the people assigned, so the fix is the crew list.
  competence: { kind: "here", anchor: "mob-crew" },
  induction: { kind: "here", anchor: "mob-induction" },
  tools: { kind: "here", anchor: "mob-tools" },
  ppe: { kind: "here", anchor: "mob-ppe" },
  customer_contact: { kind: "record" },
};

/**
 * Opens the panel that fixes a gate and scrolls to it.
 *
 * The panels collapse now, so a link that only scrolled would land on a closed heading — which is
 * worse than no link, because it looks like the platform sent you to the wrong place. Writing the
 * stored preference first means the panel is open by the time we arrive.
 */
function goToPanel(ticketId: string, panel: string) {
  window.localStorage.setItem(`panel:${ticketId}:${panel}`, "open");
  window.location.hash = `panel-${panel}`;
  window.location.reload();
}

/** Scrolls to a field on this panel. No reload — it is already on screen, just further down. */
function goToField(anchor: string) {
  const target = document.getElementById(anchor);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  // Somebody sent to a field should land able to type in it.
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) target.focus();
}

export function MobilizationPanel({ ticketId }: { ticketId: string }) {
  const readiness = trpc.operations.mobilizationReadiness.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showPlan, setShowPlan] = useState(false);

  const permissions = me.data?.permissions ?? [];
  const canDispatch = permissions.includes("ticket.dispatch");
  const canOverrideDownpayment = permissions.includes("operations.override_downpayment_gate");

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
        <h2 className="text-sm font-semibold">Mobilisation readiness</h2>
        {/*
          Renamed 2026-08-18. The company looked here for a checklist item and found a
          readiness item with a similar name — two panels on one ticket both talking about
          tools. This one is computed; §15's is signed. Saying which is which is cheaper than
          moving either.
        */}
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
            {/*
              The title is the link, and only while the item is unmet.

              A cleared gate is a statement, not a task: making it clickable too would invite people
              to go and re-do work that is already done. `record` links need a site to link to, so
              they fall back to plain text when the ticket has no account — a link to nowhere is
              worse than no link at all.
            */}
            <ItemTitle
              item={item}
              ticketId={ticketId}
              accountId={data.accountId}
              salesOrderId={data.salesOrderId}
              destination={GATE_DESTINATION[item.key]}
            />
            {!item.mandatory && item.state !== "pass" && (
              // Shown but not blocking, and said plainly so nobody chases the wrong line.
              <span className="text-xs text-text-muted">(not blocking)</span>
            )}

            <span className="w-full text-xs text-text-muted">{item.detail}</span>
            {item.key === "downpayment" && item.state === "fail" && canOverrideDownpayment && (
              <DownpaymentOverride ticketId={ticketId} onDone={refresh} />
            )}
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

/**
 * A readiness title: a link when it is something you can go and fix, plain text when it is not.
 *
 * The two in-app jumps are buttons rather than anchors because they do not change the address; the
 * account link is a real anchor, so it behaves like every other record link in the platform.
 */
function ItemTitle({
  item,
  ticketId,
  accountId,
  salesOrderId,
  destination,
}: {
  item: { key: string; label: string; state: string; mandatory: boolean };
  ticketId: string;
  accountId: string | null;
  salesOrderId: string | null;
  destination: Destination | undefined;
}) {
  const weight = item.mandatory ? "font-medium" : "";
  const done = item.state === "pass" || item.state === "not_applicable";

  if (done || !destination) return <span className={weight}>{item.label}</span>;

  if (destination.kind === "record") {
    if (!accountId) return <span className={weight}>{item.label}</span>;
    return (
      <a
        className={`${weight} underline decoration-dotted underline-offset-2`}
        href={`/crm/accounts/${accountId}`}
      >
        {item.label} &rarr;
      </a>
    );
  }

  if (destination.kind === "order") {
    if (!salesOrderId) return <span className={weight}>{item.label}</span>;
    return (
      <a
        className={`${weight} underline decoration-dotted underline-offset-2`}
        href={`/sales-orders/${salesOrderId}`}
      >
        {item.label} &rarr;
      </a>
    );
  }

  return (
    <button
      type="button"
      className={`${weight} underline decoration-dotted underline-offset-2`}
      onClick={() =>
        destination.kind === "panel"
          ? goToPanel(ticketId, destination.panel)
          : goToField(destination.anchor)
      }
    >
      {item.label} &rarr;
    </button>
  );
}

/**
 * docs/DECISIONS.md #186's `operations.override_downpayment_gate` — the fourth of its kind, same
 * shape as §5's cash advance override on its own panel. This one lives here rather than on a
 * dedicated panel of its own: the fact being overridden is the sales order's, but the *decision* —
 * send this particular crew anyway — is scoped to this ticket, so it sits on the screen that
 * decides mobilisation, not the one that shows the money.
 */
function DownpaymentOverride({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const override = trpc.operations.overrideMobilizationDownpaymentGate.useMutation({
    onSuccess: () => {
      setOpen(false);
      setReason("");
      onDone();
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-1" onClick={() => setOpen(true)}>
        Mobilise anyway
      </Button>
    );
  }

  return (
    <div className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm text-amber-900">
        This sends a crew to site before the customer has paid. Say why — an officer will read this
        later.
      </p>
      <Textarea
        className="mt-2"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Long-standing client, VP approved by phone, PO number..."
      />
      {reason.trim().length < 10 && (
        <p className="mt-1 text-xs text-amber-900">
          {reason.trim().length === 0
            ? "Write the reason before you can override — at least 10 characters."
            : `${10 - reason.trim().length} more character${10 - reason.trim().length === 1 ? "" : "s"} before you can override.`}
        </p>
      )}
      {override.error && <p className="mt-2 text-sm text-danger">{override.error.message}</p>}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={override.isPending || reason.trim().length < 10}
          onClick={() => override.mutate({ ticketId, reason })}
        >
          {override.isPending ? "Overriding…" : "Override the gate"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
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
  const people = trpc.operations.inspectionAttendees.useQuery(undefined, { retry: false });
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
        <Row
          label="Crew"
          value={
            row.crewIds.length === 0
              ? "nobody yet"
              : `${row.crewIds.length} ${row.crewIds.length === 1 ? "person" : "people"}`
          }
        />
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
          {/*
            The control the readiness gate always assumed existed.

            §8's `crew` gate fails while nobody is assigned — correctly, since "a mobilisation with
            no crew is a van leaving empty" — and the panel said "correct it below once the row
            exists" while offering nowhere to do it. So a ticket whose crew changed after scheduling
            could never clear the gate from this screen. Reported by the company as "no place to
            enter or book crew to clear this gate", and it is the fourth of its kind (DECISIONS
            #101): a gate whose evidence has no control.

            It writes to the mobilisation's own `crewIds` rather than to the ticket, because who is
            actually in the van on the day is a different fact from who was booked a week ago, and
            §8 wants the first.
          */}
          <div>
            <Label htmlFor="mob-crew">Who is in the van</Label>
            {/*
              A picker plus chips, matching the schedule panel — the company asked for a dropdown
              rather than a row of ticks, and it is the better control once a van holds four or five
              people: ticks make you read every name to work out who is on, whereas the chips say who
              is going and the list offers only who is not.

              As many as you like. The van is whoever is in it.
            */}
            <div id="mob-crew" className="mt-1 flex flex-wrap items-center gap-2">
              <Select
                className="w-52"
                value=""
                disabled={update.isPending}
                onChange={(event) => {
                  if (!event.target.value) return;
                  update.mutate({
                    mobilizationId,
                    crewIds: [...row.crewIds, event.target.value],
                  });
                }}
              >
                <option value="">Add somebody…</option>
                {(people.data ?? [])
                  .filter((person) => !row.crewIds.includes(person.id))
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </Select>

              {row.crewIds.map((id) => {
                const person = (people.data ?? []).find((candidate) => candidate.id === id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm"
                  >
                    {person?.name ?? "Somebody"}
                    <button
                      type="button"
                      aria-label={`Take ${person?.name ?? "them"} out of the van`}
                      className="text-text-muted hover:text-danger"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          mobilizationId,
                          crewIds: row.crewIds.filter((crewId) => crewId !== id),
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
            {row.crewIds.length === 0 && (
              <p className="mt-1 text-xs text-danger">
                Readiness stays blocked until at least one person is going.
              </p>
            )}
          </div>

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
              id="mob-induction"
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
