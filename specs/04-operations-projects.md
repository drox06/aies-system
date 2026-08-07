# Module 04 — Operations, Tickets, Projects and Field Service

**Depends on:** 00, 03. **Blocks:** 05 (final billing), 08.
**Definition of done:** a PO generates a ticket, the ticket routes to the correct operational
path, cash advances and material requests clear before mobilization, a technician completes the
work on a phone with no signal, QA and T&C gates are enforced, and the close-out pack is
generated automatically.

> ✅ **Reconciled against `FLOWCHART - OPERATIONS.pdf`.** This spec now implements the company's
> actual operations flow. Where this file and the flowchart disagree, the flowchart wins — raise
> it rather than silently choosing.

---

## 1. The flowchart, as implemented

```
                            PO (from module 03)
                                   │
                          ┌────────▼────────┐
                          │ TICKET GENERATION│
                          └────────┬────────┘
                                   │
                   ┌───────────────┴────────────────┐
                   │   CASH ADVANCE REQUIRED? (Y/N) │   ← gate, all ticket types
                   │   N ──> Cash Advance ──> back  │
                   └───────────────┬────────────────┘
                                   │
        ┌──────────────┬───────────┴──────────┬──────────────┐
        │              │                      │              │
   NEW PROJECT    INSTALLATION           AFTER SALES      DELIVERY
        │              │                      │              │
  SITE INSPECTION      │                      │          DR REQUEST
        │              │                      │              │
   METHODOLOGY         │                      │           DR issued?
        │              │                      │              │
        └──────────────┴──────────┬───────────┘         MOBILIZATION
                                  │                          │
                   ┌──────────────┴──────────────┐    Look for contact
                   │ MATERIAL REQUEST? (Y/N/NA)  │           │
                   │ Y ──> Material Request ──>  │      Item delivered? ──N──┐
                   └──────────────┬──────────────┘           │ Y            │
                                  │                     DR SIGNED? ──N──────┤
                            MOBILIZATION                     │ Y            │
                                  │                          │        (retry loop)
                          PROJECT EXECUTION ◄──────┐         │
                                  │                │         │
                              QA GATE ──fail───────┤         │
                                  │ pass           │         │
                          T&C (Testing &           │         │
                           Commissioning)          │         │
                                  │                │         │
                          WARRANTY GATE ──claim────┘         │
                                  │ no claim                 │
                           SERVICE REPORT                    │
                                  │                          │
                          PROJECT CLOSE OUT                  │
                                  │                          │
                                  └────► DEMOBILIZATION ◄────┘
```

Two things to notice in the company's flow that shape the data model:

1. **The delivery lane is genuinely separate.** It has its own mobilization and demobilization
   and its own retry loops. It is not a step inside a project — it is a ticket type. Model it as
   such.
2. **Two gates sit before mobilization** (cash advance, material request) and **two gates sit
   after execution** (QA, warranty). A crew that mobilizes without cash or materials is a wasted
   day, and this is exactly the coordination that currently happens verbally. Enforce both.

---

## 2. Concept model

- A **Ticket** is the unit of operational work generated from a PO. It carries a type that
  determines its route. This is the company's own term — use it in the UI, the code, and the
  numbering. Do not rename it to "job order".
- A **Project** exists only for `new_project`, `installation`, and `after_sales` tickets that
  involve field execution. It holds the schedule, the team, the budget vs actual, and the
  close-out pack. A single PO can generate several tickets, and several tickets can roll up to
  one project.
- A **Delivery ticket** has no project. It runs the right-hand lane and closes on a signed DR.

```
CustomerPO / SalesOrder ──> Ticket(s) ──┬──> type=new_project  ──> Project ──> execution lane
                                        ├──> type=installation ──> Project ──> execution lane
                                        ├──> type=after_sales  ──> Project ──> execution lane
                                        └──> type=delivery     ──> delivery lane ──> signed DR
```

---

## 3. Data model

```prisma
model Ticket {
  id, number                              // TKT-{YY}-{#####}
  salesOrderId?, customerPOId?, accountId, siteId
  type          // new_project | installation | after_sales | delivery
  subType?      // for after_sales: warranty | corrective | preventive | calibration | troubleshooting | training
  priority      // low | normal | high | emergency
  title, scopeOfWork, specialInstructions?
  status        // generated | cash_advance_pending | material_pending | ready_to_mobilize
                // | mobilized | in_progress | qa | tc | for_closeout | completed | cancelled | on_hold
  projectId?                              // null for delivery tickets
  raisedById, raisedAt
  assignedLeadId?, assignedUserIds String[]
  requiredByDate?, holdReason?
  cashAdvanceRequired Boolean             // the Y/N gate
  materialRequestStatus                   // required | not_applicable | requested | issued | partial
  customFields Json
}

model Project {
  id, code, salesOrderId?, accountId, siteId
  name, description, scopeOfWork
  status        // planning | site_inspection | methodology | mobilising | in_progress
                // | qa | tc | for_closeout | closed | on_hold | cancelled
  plannedStart, plannedEnd, actualStart?, actualEnd?
  projectManagerId, teamMemberIds String[]
  contractValue, budgetCost, actualCost   // permission-gated
  progressPct, riskLevel, holdReason?
  customFields Json
}
```

Ticket numbering is its own sequence in the numbering service (Spec.md §5). Add
`Ticket = TKT-{YY}-{#####}` to that table.

---

## 4. Ticket generation

Triggered by `customer_po.received` / `sales_order.created` from module 03.

- The system **proposes** tickets by reading the sales order lines: lines with
  `requiresExecution` propose an installation or new-project ticket; goods-only lines propose a
  delivery ticket; contract lines propose after-sales tickets on schedule.
- Operations **confirms or edits** the proposed set before generation. Do not auto-generate
  silently — one PO can legitimately be one ticket or eight, and only a human knows which.
- Each ticket links back to the specific sales order lines it covers, so fulfilment counters and
  billing milestones stay accurate.
- A ticket can also be raised standalone (warranty callback, emergency, goodwill visit) with no
  PO. These have `billable = false` by default and a required justification.

---

## 5. Gate 1 — Cash advance (before mobilization)

This is a real constraint in the flowchart and is currently invisible to everyone until a
technician can't board a bus. Make it a blocking, tracked step.

```prisma
model CashAdvance {
  id, number, ticketId?, projectId?, requestedById, requestedFor String[]   // crew members
  purpose, breakdown Json     // [{ category, description, amount }]
  amountRequested, amountApproved?, currency
  neededBy Date
  status      // draft | pending_approval | approved | rejected | released | liquidated | partially_liquidated | overdue_liquidation | extended
  approvedById?, approvedAt?, rejectionReason?
  extensions Json    // [{ requestedAt, requestedById, reason, newDueAt, approvedById, approvedAt }]
  releasedById?, releasedAt?, releaseMethod   // cash | bank_transfer | gcash | petty_cash
  liquidationDueAt, liquidatedAt?
  amountLiquidated?, amountReturned?, amountReimbursed?
}

model CashAdvanceLiquidation {
  id, cashAdvanceId, submittedById, submittedAt
  lines Json          // [{ date, category, description, amount, receiptFileId, hasOfficialReceipt }]
  totalSpent, balanceReturned, balanceReimbursable
  status              // draft | submitted | under_review | approved | rejected
  reviewedById?, reviewedAt?, remarks?
}
```

Rules:
- The ticket's `cashAdvanceRequired` flag drives the gate. If `true`, status sits at
  `cash_advance_pending` and **mobilization is blocked** until the advance is `released`.
  `operations.override_ca_gate` allows a logged override.
- Categories: transport, fuel, meals, accommodation, tolls and parking, permits and gate passes,
  consumables, contingency. Seeded and configurable.
- **The Vice President approves every advance, at any amount.** No thresholds in v1. The request
  comes from the assigned team leader or the Operations Manager, covering the whole crew on one
  advance. Release is by bank transfer, or petty cash for small amounts.
- **Automatic fallback to the President after 4 working hours** (Spec.md §4.4) — the shortest
  window of any approval type, because a crew is standing by. No nomination step. A five-person
  company with one approver who is on a plane must not equal a stalled mobilization.
- **Liquidation is due 3 working days after demobilization**, counted on the working calendar.
  Overdue liquidation blocks that person from requesting a new advance and appears on the finance
  dashboard.
- **Extensions are approved by the Vice President and may be indefinite.** Build it as a request
  → approve record carrying a reason and a new due date — never a silent edit of the deadline.
  The register must always distinguish *outstanding*, *formally extended and why*, and *simply
  late*, because an indefinitely extendable deadline becomes no deadline unless the extension
  itself is visible and counted.
- Approved liquidation lines post as project costs (module 05) automatically. Do not make
  someone re-key them as expenses.
- Emits `cash_advance.requested`, `cash_advance.released`, `cash_advance.liquidation_overdue`.

---

## 6. New-project prerequisites — site inspection and methodology

Only `new_project` tickets take this branch, per the flowchart.

### 6.1 Site inspection

```prisma
model SiteInspection {
  id, number, ticketId, projectId?, siteId
  inspectedAt, inspectedByIds String[]
  findings, existingConditions Json
  measurements Json, tagNumbers String[]
  accessConstraints, permitsRequired String[], hazards String[]
  utilitiesAvailable Json     // power, air, water, crane, scaffolding
  photoFileIds String[], sketchFileIds String[]
  status      // scheduled | completed | approved
  scopeChangeIdentified Boolean, scopeChangeNotes?
}
```

- Uses a versioned checklist template (§9) so inspections are consistent and auditable.
- **If `scopeChangeIdentified` is true, emit `scope_change.identified`.** Module 02 subscribes and
  prompts sales to raise a quotation revision. Discovering at inspection that the job is bigger
  than quoted is normal; discovering it *after* mobilization is expensive. This link is one of
  the highest-value things the platform does.
- This is also the sub-flow module 01 calls when sales requests a pre-quotation inspection —
  same record type, raised from an inquiry instead of a ticket.

### 6.2 Methodology

The method statement: how the work will actually be done. It is a **controlled document** (module
07), not a free-text field.

```prisma
model Methodology {
  id, number, projectId, ticketId
  title, revision
  scopeSummary, sequenceOfWork Json      // ordered steps with duration and crew
  manpowerPlan Json, toolsRequired String[], materialsRequired Json
  safetyPlan, jsaFileId?                 // job safety analysis
  permitsRequired String[], environmentalConsiderations?
  durationDays, mobilizationPlan, demobilizationPlan
  contingencyPlan?
  status      // draft | internal_review | approved | submitted_to_client | client_approved | client_rejected | superseded
  preparedById, reviewedById?, approvedById?, approvedAt?
  submittedToClientAt?, clientApprovedAt?, clientApprovalFileId?, clientRejectionNotes?
  clientApprovalRequired Boolean @default(true)
  documentId                              // the controlled document in module 07
}
```

- Generates a branded PDF for client submission where the customer requires method statement
  approval before work (common in power and water utilities).
- **The client approves the methodology before work starts. Always.** `clientApprovalRequired`
  defaults to `true` and the flag exists only so a rare exception can be recorded, not as a
  routine setting. Mobilization is blocked until `status = client_approved` **and** the client's
  approval document is attached. Override is permissioned (`operations.override_methodology_gate`,
  president and VP only) and logged with a reason.
- Track the submission-to-approval turnaround. Client methodology approval is a common and
  invisible source of schedule slip, and AIES is usually blamed for delays it did not cause. A
  dated submission record changes that conversation.
- `client_rejected` returns the methodology to draft with the client's comments captured, and
  creates a revision — the revision chain is the evidence of what was agreed.
- Methodologies are reusable: clone from a previous project of the same type, which is how the
  company builds an institutional library instead of rewriting from scratch each time.
- The tools and materials lists here **pre-populate the material request** in §7. Nobody should
  type the same list twice.

---

## 7. Gate 2 — Material request (before mobilization)

The flowchart's Y / N/A / N diamond. All three outcomes are real: materials needed, not
applicable to this ticket, or needed but not yet available.

```prisma
model MaterialRequest {
  id, number, ticketId, projectId?, requestedById, requestedAt, neededBy
  status      // draft | pending_approval | approved | partially_issued | issued | purchased | rejected | cancelled
  approvedById?, approvedAt?
  issuedById?, issuedAt?
  returnDueAt?, returnedAt?
}

model MaterialRequestLine {
  id, requestId, lineNo
  itemType        // consumable | spare_part | tool | instrument | ppe | rental
  productId?, description, quantity, unit
  source          // stock | purchase | customer_supplied | rental
  qtyIssued, qtyReturned, qtyConsumed
  calibrationAssetId?    // links to module 08 when a measuring instrument is drawn
  status, notes
}

model StockItem   { id, sku, name, category, unit, qtyOnHand, reorderLevel, location, lastCountedAt }
model StockMovement { id, stockItemId, type, quantity, ticketId?, requestId?, reference, byId, at }
```

Notes:
- This is the **minimum viable inventory** the flowchart demands: consumables, spares, tools, and
  instruments issued from the office and returned after demobilization. It is deliberately not
  the full valuation-and-costing inventory system from Spec.md open question 3 — that remains
  open. Track quantity and custody, not weighted-average cost.
- Lines with `source = purchase` emit `material.purchase_required` → module 03 raises a purchase
  request. The ticket sits at `material_pending` until resolved.
- **Instruments drawn against a ticket are recorded.** This is what makes module 08's
  out-of-tolerance impact assessment possible ("which jobs used this instrument since its last
  valid calibration?"). Drawing an overdue-calibration instrument is blocked.
- **Tool return is tracked on demobilization.** Unreturned tools appear on an outstanding-custody
  list per technician. Tools disappear otherwise; this is universal.
- `N/A` is a legitimate, recorded answer — not a skipped step. The record shows someone decided.

---

## 8. Mobilization, execution, demobilization

```prisma
model Mobilization {
  id, ticketId, projectId?, type          // mobilization | demobilization
  plannedAt, actualAt?
  crewIds String[], vehicleRef?, driverName?
  toolsChecklist Json, ppeChecklist Json
  gatePassStatus, permitStatus, inductionCompleted Boolean
  departureOdometer?, arrivalOdometer?
  status, notes, photoFileIds String[]
}
```

- **Mobilization readiness check** runs automatically and shows a green/red list: cash advance
  released, materials issued, methodology approved (new projects), crew assigned and competent
  (module 08), gate pass and permits obtained, tools checked out, PPE confirmed, customer contact
  confirmed. `ready_to_mobilize` is only reachable when all mandatory items pass.
- Execution: daily progress logging against the methodology's sequence of work — steps completed,
  percent complete, manpower on site, weather and standby time, issues raised, photos. Daily
  progress reports generate as PDFs where the customer requires them.
- **Standby and delay tracking** with cause codes (client not ready, permit delay, weather,
  material shortage, equipment failure, access denied). This is the evidence base for a variation
  claim, and today it exists only in people's memory.
- **Demobilization** closes the loop: tools returned and reconciled against the material request,
  site cleared, customer notified, cash advance liquidation triggered, crew released.

---

## 9. Gate 3 — QA (client inspection, with rework loop)

**Confirmed: QA is performed and approved by the client, not by AIES.** The customer inspects the
work. The Operations Manager records whether they approved it and uploads the customer's own
documentation as evidence. The flowchart's QA diamond loops failures back to Project Execution —
implement that literally.

This is a simpler mechanism than an internal QA function, and a stronger one commercially: the
uploaded client approval is simultaneously the quality record, the release authorisation under
clause 8.6, and the best support the company will ever have for the final bill.

```prisma
model QAApproval {
  id, number, ticketId, projectId?
  inspectedAt, clientInspectorName?, clientInspectorPosition?
  approved Boolean                    // the toggle the Operations Manager sets
  recordedById                        // must hold qa.record — operations manager or above
  recordedAt
  evidenceFileIds String[]            // the client's documentation — REQUIRED when approved
  evidenceType     // client_signed_form | email_confirmation | inspection_report | punch_sheet | other
  remarks?
  defects Json     // [{ description, severity, ownerId, dueAt, status, photoFileIds }]
  reworkTicketId?, reworkRound Int
}
```

Rules:

- **`approved = true` cannot be saved without at least one evidence file.** Not a warning, a
  hard block. An unevidenced approval is an assertion, and the whole point of the toggle is that
  it is backed by something the client produced. If the client approved verbally, the Operations
  Manager writes it up, notes `evidenceType = other`, and uploads that — a contemporaneous note
  is weak evidence but it is evidence, and it is honest about what it is.
- **`approved = false`** returns the ticket to `in_progress`, increments `reworkRound`, creates a
  rework task per defect (module 06), and — for major or critical defects — auto-raises an NCR
  in module 08.
- Rework rounds are counted and reported. First-time-right (module 09) is `reworkRound = 0`.
  This is the quality metric that matters most and is currently unmeasurable.
- Rework cost is captured separately from original execution cost, so cost of poor quality is a
  visible number in module 05's project P&L.
- The client's approval document is filed as a **record** in the DMS against the project, and it
  is one of the documents the final billing gate checks for (module 05 §4).
- Where a client does not inspect at all, the Operations Manager records that fact explicitly
  rather than leaving the gate blank — `evidenceType = other` with a note. A silently skipped
  gate and a deliberately waived one look identical in a database unless you make them different.

## 10. T&C — Testing and Commissioning

```prisma
model TestingCommissioning {
  id, number, ticketId, projectId
  startedAt, completedAt?
  loopChecks Json           // [{ tagNumber, loopId, result, remarks }]
  functionalTests Json      // [{ test, criteria, measured, unit, result }]
  performanceVerification Json   // against the quoted specification
  calibrationAssetsUsed String[]  // module 08 traceability
  witnessedByCustomer Boolean, customerWitnessName?, customerWitnessPosition?
  punchItems Json           // [{ description, severity, ownerId, dueAt, status }]
  result        // accepted | accepted_with_punch | rejected
  trainingDelivered Json    // [{ topic, attendees, durationHours, materialsFileId }]
  certificateFileId?
  signedOffById?, customerSignatureFileId?, signedAt?
}
```

- Test results are compared against the **specification from the accepted quotation** (module 02),
  not against a value typed in by the technician. Out-of-spec results are flagged automatically.
- Instruments used are recorded for traceability (module 08 §3).
- **Punch list:** open items with owner, severity, and due date. Critical punch items block
  project close-out.
- Generates a Testing & Commissioning Certificate PDF for customer signature. This is a primary
  billing trigger document.

---

## 11. Gate 4 — Warranty

The flowchart's warranty diamond after T&C loops back to Project Execution. This models the
warranty callback: work already commissioned comes back for rectification.

- On `warranty` determination, the platform checks the equipment's warranty window (§14) and:
  - **In warranty** → raises an `after_sales` ticket with `subType = warranty`, `billable =
    false`, linked to the original project, which re-enters the execution lane at Project
    Execution exactly as the flowchart shows.
  - **Out of warranty** → prompts sales to quote the rectification (module 01/02), because it is
    chargeable work.
  - **AIES-caused defect** → the warranty ticket is non-billable *and* auto-raises an NCR
    (module 08), because a defect the company caused is a quality event, not just a job.
- Warranty tickets are reported separately: count, cost, and root cause by product and by
  technician. Warranty cost that nobody totals is warranty cost that never gets fixed.
- Passing the gate with no claim proceeds to Service Report.

---

## 12. Service report and close-out

```prisma
model ServiceReport {
  id, number, ticketId, projectId?
  workPerformed, findings, recommendations?, partsUsed Json
  equipmentIds String[]
  startedAt, finishedAt, travelTimeMin?, standbyTimeMin?
  status      // draft | pending_signature | signed | submitted | approved
  customerSignatureFileId?, customerName?, customerPosition?, customerRemarks?
  technicianSignatureFileId?, photoFileIds String[]
  followUpRequired Boolean, followUpNotes?, ncrRaised Boolean
}

model ProjectCloseOut {
  id, projectId, checklist Json
  status        // in_progress | submitted | approved
  documentIds String[], submittedById?, approvedById?, approvedAt?
  customerAcceptanceFileId?, acceptanceDate?
  lessonsLearned?
}
```

- The service report assembles from checklist responses, work narrative, parts used, photos, and
  time. Customer signs on the technician's device; the PDF emails to the customer on sync and
  files against the equipment and project.
- **Close-out pack**, generated as one indexed PDF and filed as a controlled document: cover
  sheet, scope summary, approved methodology, site inspection report, delivery receipts,
  material list, QA records, T&C certificate and test results, service reports, calibration and
  test certificates, as-built documentation, spare parts list, warranty statement, training
  record, punch list closure, and customer acceptance certificate.
- Close-out is blocked by: open critical punch items, unapproved service reports, failed QA,
  unliquidated cash advances, unreturned tools, missing customer acceptance where required.
  The blockers show as a checklist so the PM can see who owns each one.
- Approval emits `project.closed` → module 05 releases final billing. **This is the explicit
  handover the brief describes.**

---

## 13. The delivery lane

The flowchart's right-hand column. Delivery tickets never enter the project lane.

```prisma
model DeliveryTicketFlow {
  id, ticketId, deliveryReceiptId?      // DR lives in module 03
  mode        // own_vehicle | courier
  drRequestedAt, drRequestedById, drIssuedAt?, drIssuedById?
  // own_vehicle
  mobilizedAt?, demobilizedAt?, vehicleRef?, driverName?
  attempts Json    // [{ attemptNo, at, contactPersonSought, contactReached, itemDelivered, drSigned, failureReason, photoFileIds, geo }]
  // courier
  courierName?, waybillNumber?, trackingUrl?, bookedAt?, pickedUpAt?
  courierPodFileId?, courierDeliveredAt?, courierRecipientName?
  freightCost?, insuredValue?
  status      // dr_requested | dr_issued | mobilized | attempting | in_transit | delivered_unsigned | completed | failed | rescheduled
  finalOutcome?, completedAt?
}
```

**Two modes, confirmed by the company: own vehicle, or courier for bulk and large items.** The
mode is chosen when the ticket is generated and can be changed until dispatch.

### 13.1 Own-vehicle mode — the loops exactly as drawn

1. **DR REQ** — operations requests the delivery receipt; module 03 generates it.
2. **DR issued?** — no DR, no mobilization. Blocking.
3. **Mobilization** — its own crew and vehicle assignment, separate from project mobilization.
4. **Look for contact person** — the driver logs whether the named contact was reached. If not,
   the app surfaces alternate contacts from the account record on the spot, rather than the
   driver phoning the office.
5. **Item delivered? → N** — logs a failed attempt with a cause code (contact unavailable, site
   closed, wrong address, customer refused, access denied, incomplete items, vehicle problem) and
   loops back. Each attempt is a row in `attempts` with timestamp and photos.
6. **DR signed? → N** — delivered but unsigned is its own state, and it is a billing risk. It
   loops back for signature chase. An unsigned DR older than N days escalates.
7. **DR SIGNED = Y** → demobilization → ticket complete → emits `sales_order.goods_delivered`.

### 13.2 Courier mode

The flowchart's mobilize → contact → attempt loop is the courier's problem, not AIES's, but the
**evidence obligation is unchanged**: AIES still needs a signed DR to bill and to close the
ticket.

1. **DR REQ** and **DR issued** as before — no DR, no booking.
2. **Book with courier**: courier name, waybill number, tracking URL, freight cost, declared or
   insured value. The DR goes with the shipment; a copy stays in the DMS.
3. **In transit**: the ticket sits at `in_transit`. Nobody mobilizes. Tracking is manual — paste
   the waybill and open the courier's page. **Do not build courier API integrations**; there are
   too many, they change, and at this volume a link is enough.
4. **Delivered**: record the courier's proof of delivery and the recipient's name.
5. **Signed DR still required.** A courier POD is not a signed AIES delivery receipt. The signed
   DR must come back — chased from the customer if the courier did not return it. Until then the
   ticket is `delivered_unsigned`, which is exactly the same billing-risk state as in own-vehicle
   mode, and it escalates on the same clock.
6. **Freight cost posts to project cost** (module 05). Courier charges on bulk deliveries are
   material and routinely forgotten in margin.

Handle the failure modes: courier delivered to the wrong person, delivered damaged (raises an NCR
and a claim task), or lost in transit (NCR plus an insurance claim record).

### 13.3 Reporting

Failed delivery attempts by cause and by customer site — repeated failures at one site are a
fixable process problem, usually a wrong contact, and nobody currently counts them. Plus
own-vehicle vs courier cost and success rate per delivery, which is the data needed to decide
when to stop driving.

---

## 14. Field application (PWA, offline-first)

The hardest technical requirement in the platform. Plants have no signal.

- **Offline store:** IndexedDB (Dexie) holding the technician's tickets for the next 7 days plus
  checklists, methodology, site data, equipment history, contact list, and reference documents.
  Service worker serves the app shell.
- **Outbox sync:** every field write (checklist responses, photos, signatures, progress logs,
  delivery attempts, timesheets, liquidation receipts) queues locally with a client-generated
  UUID. Server operations are idempotent on that UUID.
- **Conflict policy:** field data is authoritative for its own fields. The server rejects only on
  business-rule violation and surfaces the conflict on next sync — never silently discards work.
  Losing a technician's afternoon destroys trust in the system permanently. Treat this as a
  correctness requirement.
- Photos compressed client-side to ~1600px/80% before queueing. Persistent sync-status indicator
  with queue count and a manual "sync now".
- Storage guard: warn at 80% of browser quota; never silently drop queued items.
- UI: large touch targets, high contrast for outdoor screens, minimal typing, one-handed use.
- **Delivery mode** is a distinct, stripped-down screen for drivers: today's drops, navigate,
  log attempt, capture signature. Nothing else.

---

## 15. Digital checklists

Replaces the undocumented, verbal way work is currently confirmed.

- Template builder: sections → items. Item types: pass/fail, pass/fail/NA, numeric with tolerance
  limits, text, single/multi select, photo required, signature, instrument reading with unit.
- Templates are **versioned**; responses permanently record the version used, so historical
  evidence reflects the procedure actually in force.
- Conditional logic: a `fail` reveals mandatory cause and action fields and can auto-raise an NCR.
- Seed templates matching the flowchart's stages: site inspection, mobilization readiness,
  material issue and return, instrument installation, loop check, QA inspection, T&C functional
  test, safety toolbox talk / JSA, PM visit, demobilization and site clearance, delivery attempt.

---

## 16. Time, cost and installed base

```prisma
model Timesheet   { id, ticketId?, projectId?, userId, date, regularHours, overtimeHours, travelHours, standbyHours, activity, notes, status, approvedById?, approvedAt? }
model FieldExpense{ id, ticketId?, projectId?, cashAdvanceId?, userId, date, category, amount, currency, description, receiptFileIds String[], status, approvedById?, reimbursedAt? }

model Equipment {
  id, accountId, siteId, tagNumber?, serialNumber
  productId?, manufacturer, modelNumber, description
  installedAt?, installedByTicketId?, salesOrderId?, commissionedAt?
  warrantyStart?, warrantyEnd?, warrantyTerms?
  calibrationDueAt?, lastServiceAt?, nextPMDueAt?
  location?, processDescription?, status
  documentIds String[]
}

model MaintenanceContract { id, number, accountId, siteId?, startDate, endDate, visitsPerYear, scheduleRule Json, equipmentIds String[], contractValue, salesOrderId?, status }
```

- Field expenses linked to a cash advance flow into its liquidation automatically.
- Every commissioned item becomes an `Equipment` record with certificates and full history.
- PM contracts auto-generate `after_sales` tickets N days ahead of schedule.
- **Renewal loop:** contracts expiring in 90 days, calibrations due in 60, warranties expiring,
  and equipment past its service interval generate leads back into module 01. This is where the
  recurring revenue in this business lives.

---

## 17. Scheduling and dispatch

- **Dispatch board:** week/day view, technicians as rows, tickets as blocks, drag to reschedule,
  colour by ticket type using the brand palette. Shows conflicts, travel time between consecutive
  sites, and availability (leave, training, already assigned).
- **Gate status is visible on every card.** A ticket that is scheduled but has no released cash
  advance or unissued materials shows red. The dispatcher sees the blocker before the crew does.
- **Skills matching** against module 08's competence matrix; expired certification removes the
  technician from eligible assignment, with a documented override path.
- **Capacity view:** next 4 weeks of committed field days vs available technician days. This is
  the number sales needs before promising a date.
- Emergency and warranty tickets can be injected, bumping lower-priority work with notifications
  to affected owners.

---

## 18. Events

**Emits:** `ticket.generated`, `ticket.routed`, `cash_advance.requested`,
`cash_advance.released`, `cash_advance.liquidation_overdue`, `site_inspection.completed`,
`scope_change.identified`, `methodology.approved`, `material_request.raised`,
`material.purchase_required`, `material.issued`, `ticket.ready_to_mobilize`,
`ticket.mobilized`, `ticket.started`, `qa.failed`, `qa.passed`, `tc.completed`,
`warranty.claim_raised`, `service_report.approved`, `ticket.demobilized`,
`equipment.installed`, `punch_item.raised`, `project.closed`, `delivery.attempt_failed`,
`delivery.dr_signed`, `sales_order.goods_delivered`, `pm.due`, `warranty.expiring`.

**Consumes:** `customer_po.received`, `sales_order.created`, `goods.received`,
`inspection.requested`, `payment.received` (cash advance release), `quotation.accepted`.

---

## 19. Permissions

`ticket.view` · `ticket.view_all` · `ticket.generate` · `ticket.route` · `ticket.schedule` ·
`ticket.dispatch` · `ticket.execute` · `ticket.cancel` ·
`project.view` · `project.manage` · `project.close` · `project.view_cost` ·
`cash_advance.request` · `cash_advance.approve` (VP/president only) · `cash_advance.release` ·
`cash_advance.review_liquidation` · `cash_advance.approve_extension` (VP/president only) ·
`operations.override_ca_gate` ·
`material_request.raise` · `material_request.approve` · `material_request.issue` ·
`methodology.prepare` · `methodology.approve` · `operations.override_methodology_gate` ·
`qa.record` (record the client's QA outcome and upload evidence — operations manager and above) ·
`tc.signoff` ·
`service_report.approve` · `timesheet.approve` · `expense.approve` · `equipment.manage` ·
`delivery.execute`

Technicians are scoped to tickets where they are assigned. They see scope, site data, and their
own cash advances — never contract value or margin.

---

## 20. Tests

- Ticket generation from a mixed sales order proposes the correct type set; operations edits are
  respected; each ticket links the right sales order lines.
- **Cash advance gate** blocks `ready_to_mobilize` until released; only the VP or president can
  approve; override requires the permission and logs a reason; overdue liquidation blocks a new
  request, and a VP-approved extension moves the due date while remaining visibly an extension.
- Liquidation lines post to project cost exactly once and reconcile to the centavo against
  amount released, returned, and reimbursed.
- **Material request** N/A path records a decision and does not block; purchase path holds the
  ticket at `material_pending` until module 03 resolves it; drawing an overdue-calibration
  instrument is rejected.
- **Methodology gate** blocks mobilization until `client_approved` with the client's approval
  document attached; internal approval alone is not sufficient.
- **QA approval with no evidence file is rejected** at the service layer. QA `approved = false`
  returns the ticket to `in_progress`, increments `reworkRound`, and raises an NCR for major or
  critical defects only.
- **T&C** flags an out-of-spec measured value against the quoted specification.
- **Warranty gate:** in-warranty raises a non-billable ticket linked to the original project;
  out-of-warranty routes to sales; AIES-caused raises an NCR.
- **Delivery lane, own vehicle:** three failed attempts then a successful signed delivery
  produces one DR, three logged attempts with causes, and exactly one `sales_order.goods_delivered`.
- **Delivery lane, courier:** a courier POD alone does not complete the ticket; it stays
  `delivered_unsigned` until the signed DR is uploaded, and freight cost posts to project cost.
- Delivered-but-unsigned escalates after the configured window.
- Close-out blocked independently by each blocker in §12; each unblocks in isolation.
- **Offline:** lose connectivity, complete a checklist with three photos and a signature, restore,
  assert one server record with all attachments. Replaying the same outbox twice creates no
  duplicates.
- Technician scoping: cannot read an unassigned ticket or any margin field.
