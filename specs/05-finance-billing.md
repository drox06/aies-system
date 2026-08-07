# Module 05 — Finance, Billing and Collections

**Depends on:** 00, 03, 04. **Blocks:** 09.
**Definition of done:** finance can raise a downpayment invoice, bill on project completion,
record collections, track expenses, and see receivables ageing — without a spreadsheet.

> ✅ **Confirmed.** There is **no accounting package** — this platform is the operational system
> of record and exports to the accountant. AIES is **VAT-registered** and issues a **Service
> Invoice upon payment**, whether that payment is a downpayment, a progress bill, or the final
> settlement. Some customers withhold EWT and issue BIR Form 2307; some do not. See §3.

---

## 1. Scope boundary — read this first

This module does **not** build double-entry accounting. It builds the billing and collection
workflow that the described process requires, plus cost capture for project profitability, plus
a clean export for whoever keeps the books.

Do not build: chart of accounts, journal entries, trial balance, tax filing. If the user later
confirms there is no accounting package at all, that becomes a separate module 11 decision, not
a quiet scope expansion here.

---

## 2. Billing model

Per the stated process:

> *"Depending on the payment terms, a downpayment might be collected prior to order, then the
> remaining balance is paid upon completion of works (including closing documentation)."*

So the billing schedule is derived from the payment term, and its milestones are triggered by
events from modules 03 and 04.

```prisma
model PaymentTerm {
  id, name, description
  milestones Json    // [{ label, pct, trigger }]
  netDays Int
}
```

`trigger` values map to domain events:

| Trigger | Fired by |
|---|---|
| `on_order` | `sales_order.created` |
| `on_supplier_order` | `supplier_po.sent` |
| `on_delivery` | `sales_order.goods_delivered` |
| `on_installation` | `ticket.completed` (type = installation) |
| `on_tc_accepted` | `tc.completed` with result accepted — the T&C certificate is a strong billing trigger |
| `on_dr_signed` | `delivery.dr_signed` — goods-only orders bill on the signed DR, not on despatch |
| `on_project_close` | `project.closed` |
| `net_days_after_close` | scheduled from `project.closed` |

Seed terms: `50/50 (50% DP, 50% on completion)`, `30/70`, `100% on delivery`, `Net 30 after
completion`, `Progress billing`.

```prisma
model BillingSchedule     { id, salesOrderId, paymentTermId, generatedAt }
model BillingMilestone {
  id, scheduleId, salesOrderId, label, pct, amount, trigger
  status      // pending | ready_to_bill | invoiced | cancelled
  readyAt?, invoiceId?
}
```

When a trigger event arrives, the matching milestone flips to `ready_to_bill` and **notifies
finance**. Finance never has to ask operations whether a project is done — this is the core
coordination failure the platform exists to fix.

---

## 3. The two-document model — this is the most important section

AIES issues a **Service Invoice upon payment**, not upon billing. That single confirmed fact
changes the shape of this module, and getting it wrong creates a VAT liability on money that has
not arrived.

So there are two distinct documents, and they are not the same record:

| | **Billing Statement** | **Service Invoice** |
|---|---|---|
| Purpose | Demands payment for a milestone | The BIR document evidencing the sale |
| Issued when | Milestone becomes billable | **Payment is received** |
| Triggers VAT | No | **Yes** |
| Creates a receivable | Yes | No — it settles one |
| Numbering | `BS-{YY}-{#####}` | `SI-{YY}-{#####}` — must be a strict, gapless-tracked sequence |
| Cancellable | Yes, freely | **No.** Cancelled or voided invoices are retained and marked, never deleted or renumbered. |

A single billing statement can produce several service invoices if the customer pays in
instalments, and a single payment covering two statements produces the invoice split
accordingly. Model the relationship as many-to-many through the payment.

```prisma
model BillingStatement {
  id, number, type          // downpayment | progress | final | service | credit_note
  accountId, salesOrderId?, projectId?, ticketId?, milestoneId?
  statementDate, dueDate, currency
  subtotal, vatMode, vatAmount, total
  expectedWithholdingAmount        // computed from the account's EWT setting
  expectedNetCollectible           // total − expected withholding
  amountPaid, balance
  status     // draft | pending_approval | issued | partially_paid | paid | overdue | cancelled | written_off
  poReference?, drReferences String[], srReferences String[], tcCertificateRef?
  notes, terms, issuedById?, issuedAt?
}

model BillingStatementLine { id, statementId, lineNo, salesOrderLineId?, description, quantity, unit, unitPrice, lineTotal, vatable Boolean }

model ServiceInvoice {
  id, number                       // SI-{YY}-{#####}, strict sequence
  accountId, paymentId             // the payment that caused it — mandatory
  billingStatementIds String[]     // what it settles
  invoiceDate                      // = the date payment was received
  vatableSales, vatExemptSales, zeroRatedSales, vatAmount
  grossAmount, withholdingTaxAmount, netAmountReceived
  status      // issued | cancelled
  cancellationReason?, cancelledById?, cancelledAt?
  pdfFileId, issuedById
}

model Payment {
  id, number, accountId, receivedAt
  method            // bank_transfer | check | cash | online | gcash
  reference, bankAccountId?, amount, currency
  checkNumber?, checkDate?, clearedAt?          // PDCs: received ≠ collected
  withholdingTaxAmount?, form2307FileId?, form2307ReceivedAt?
  proofFileId?, recordedById, notes
  serviceInvoiceId?                              // generated on recording
}

model PaymentAllocation { id, paymentId, billingStatementId, amount }

model CollectionActivity { id, statementId, accountId, type, contactedAt, contactId?, notes, promisedDate?, outcome, byId }
```

### 3.1 Recording a payment issues the invoice

Recording a payment is therefore a **transaction that produces a BIR document**, not a bookkeeping
note. The flow:

1. Finance records the payment: amount, method, reference, proof of remittance.
2. If the account withholds, finance enters the withheld amount. The system checks it against
   the expected figure and flags a mismatch rather than accepting it silently.
3. The system allocates across open billing statements (suggested oldest-first, editable).
4. **A Service Invoice is generated and numbered**, with the VAT breakdown, the withholding
   deduction, and the net received.
5. The invoice PDF is filed to the DMS and emailed to the customer.

A payment cannot be recorded without producing an invoice, and an invoice cannot exist without a
payment. Enforce both directions in the service layer.

### 3.2 Withholding tax — per account, because it varies

`Account.withholdsEWT` (boolean) and `Account.ewtRate` (default 2% for services). Some AIES
customers withhold and issue 2307; some do not.

- Billing statements show the expected net collectible when the account withholds, so nobody is
  surprised when less money arrives than the statement said.
- **A payment with withholding but no 2307 on file is an open item.** Unrecovered 2307s are real
  money — they are creditable against income tax and worthless if never collected. Track them in
  a dedicated register with ageing, and chase them quarterly, not at year end when the customer's
  accounting staff has changed.
- If any customer is a government agency, flag it: government withholds at different rates and
  also withholds VAT. The system should support a per-account override rather than assuming 2%.

### 3.3 Philippine practicalities

- **VAT** at 12%, with `zero_rated` and `exempt` modes available per statement. Invoice PDFs show
  the VAT breakdown, the company TIN, and the customer TIN.
- **Post-dated checks** are normal. A received PDC is *not* collected cash — it sits in a PDC
  register until `clearedAt`, and only clearing settles the statement and triggers the invoice.
  Getting this wrong overstates collections and issues an invoice against money that may bounce.
- **Sequence integrity.** Service invoice numbers are allocated in a locked transaction, never
  reused, never reordered. Gaps are permitted but logged with a reason — BIR expects to be able
  to account for every number in the series.
- Statement of account PDF per customer, generated on demand.

## 4. Final billing gate

A `final` **billing statement** cannot be issued until **all** of:

- Project status is `closed` (or the order has no executable scope).
- All service reports for executable lines are `approved`.
- QA has passed (no open `fail` result) and the T&C certificate is signed where the scope
  included commissioning.
- All cash advances against the project are liquidated, or the balance is explicitly written off
  with approval.
- The close-out pack exists and, if required by the customer, the acceptance certificate is
  signed.
- All delivery receipts are `acknowledged`.

- **The client has approved QA** and the evidence document is uploaded (module 04 §9). Since QA
  approval is the customer's own inspection, its documentation is also the strongest possible
  support for the final bill — the gate and the collection argument are the same artifact.

The gate is shown as a checklist on the statement draft, so finance sees exactly what is missing
and who owns it. `finance.override_billing_gate` — held by the president and vice president only
— allows proceeding with a logged reason.

---

## 5. Receivables and collections

- **AR ageing:** current / 1–30 / 31–60 / 61–90 / 90+, by account and by owner, with drill-down. Ageing runs on **billing statements**, not service invoices — the invoice only exists once the money is in.
- **Collection worklist:** overdue statements sorted by amount × days overdue, with the last
  contact, the promised payment date, and a one-click "log follow-up".
- Automated reminder emails at configurable intervals (default: 3 days before due, on due date,
  +7, +15, +30), with templates and an off switch per account — some customers must be handled
  by phone only.
- **Statement of account** PDF per customer, generated on demand.
- **2307 chase list:** payments with withholding recorded but no certificate on file, by age.
- Credit limit check at sales order creation: warn (default) or block (setting) when an account's
  open AR plus the new order exceeds `creditLimit`.

---

## 5b. Cash advances and liquidation

The operations flowchart makes cash advance a **blocking gate before mobilization** (module 04
§5). Finance owns the money side of that loop; module 04 owns the records. Do not duplicate the
model — subscribe to its events.

Finance responsibilities here:

- **Release queue:** approved advances awaiting disbursement, sorted by `neededBy`. A crew
  scheduled to mobilize tomorrow morning with an unreleased advance is the top of this list, and
  it is visible to operations too, so nobody has to chase it in a chat app.
- **Release recording:** method (cash, bank transfer, GCash, petty cash), reference, and proof.
  Emits `cash_advance.released`, which unblocks module 04's mobilization gate.
- **Liquidation review:** verify receipts against the breakdown, approve, and record the returned
  or reimbursable balance. Approved liquidation lines post as project costs automatically —
  they must not be re-keyed as expenses.
- **Outstanding advances register:** by person and by project, with ageing. Advances outstanding
  past the liquidation deadline block new requests for that person (override permissioned) and
  appear on the finance dashboard. Unliquidated advances are the most common quiet cash leak in
  a business of this shape; make the number impossible to avoid looking at.
- **Petty cash fund** tracking with replenishment: opening balance, disbursements, replenishment
  requests, and a reconciliation record.
- **BIR reality check:** liquidation lines should record whether an Official Receipt was
  obtained, since expenses without one are generally non-deductible. Flag lines missing an OR so
  the shortfall is visible before year end, not after.

Consumes: `cash_advance.requested`, `cash_advance.released`, `cash_advance.liquidation_overdue`.

---

## 6. Cost capture and project profitability

Costs come from four places, all already captured elsewhere:

1. Supplier PO landed cost (module 03).
2. Approved cash advance liquidation lines (module 04 §5).
3. Field expenses not covered by an advance (module 04).
4. Labour cost from approved timesheets × the user's cost rate, including overtime, travel, and
   standby hours captured during execution.
5. Materials issued from stock against a material request (module 04 §7), at last purchase cost.
6. **Rework cost from failed QA rounds, tracked separately** — this is the cost of poor quality
   and it should be reportable on its own, not buried in project cost.
7. Direct expenses entered here (subcontractors, permits, equipment rental).

```prisma
model Expense {
  id, number, category, vendorName?, expenseDate
  amount, currency, vatAmount?, description
  salesOrderId?, projectId?, jobOrderId?, departmentId?
  paymentMethod, receiptFileIds String[]
  status      // draft | submitted | approved | rejected | paid
  submittedById, approvedById?, paidAt?
}
model CostRate { id, userId, effectiveFrom, hourlyCost, overtimeMultiplier }
```

**Project P&L view** (permission-gated): contract value, recognised revenue, cost by category,
budget vs actual, gross margin, and variance against the margin quoted in module 02. The gap
between *quoted margin* and *actual margin* is the single most useful number the platform can
give management, because today it is unknowable.

---

## 7. Payables (light)

Track supplier invoices against supplier POs, with three-way matching (PO ↔ goods receipt ↔
supplier invoice) and a payables ageing list. Do not build a payment run or bank integration.

---

## 8. Accounting export

- Configurable CSV/XLSX export of invoices, payments, expenses, and supplier bills for the
  period, in a mapping the accountant defines (column mapping stored in settings).
- QuickBooks/Xero-compatible layouts as presets.
- Export runs are recorded so the same period is not exported twice unnoticed.

---

## 9. Events

**Emits:** `billing_statement.issued`, `billing_statement.overdue`, `payment.received`,
`payment.cleared`, `service_invoice.issued`, `form2307.outstanding`, `expense.approved`,
`credit_limit.exceeded`, `milestone.ready_to_bill`.

**Consumes:** `sales_order.created`, `downpayment.required`, `supplier_po.sent`,
`sales_order.goods_delivered`, `delivery.dr_signed`, `ticket.completed`, `tc.completed`,
`project.closed`, `goods.received`, `cash_advance.requested`, `cash_advance.released`,
`cash_advance.liquidation_overdue`.

**Emits additionally:** `cash_advance.released`, `liquidation.approved`, `petty_cash.low`.

---

## 10. Permissions

`finance.view` · `finance.view_cost` · `invoice.create` · `invoice.approve` · `invoice.issue` ·
`invoice.cancel` · `payment.record` · `expense.submit` · `expense.approve` · `ar.view` ·
`ap.view` · `finance.export` · `finance.override_billing_gate` · `project.view_pl` ·
`billing_statement.create` · `billing_statement.issue` · `billing_statement.cancel` ·
`service_invoice.cancel` · `payment.record` · `cash_advance.approve` · `cash_advance.release` ·
`cash_advance.review_liquidation` · `cash_advance.approve_extension` · `cash_advance.write_off` ·
`petty_cash.manage`

`cash_advance.approve` and `cash_advance.approve_extension` are held by `vice_president` and
`president` only. `finance.view_cost` and `project.view_pl` likewise.

Money is the most sensitive data in the system. Default every finance permission to **off**.
Cost, margin, and approval authority sit with `president` and `vice_president` only; the other
three managers see order values and their own expenses, not company margin.

---

## 11. Tests

- **Recording a payment produces exactly one service invoice**, correctly numbered, with VAT and
  withholding computed; the invoice cannot be created without a payment, nor the payment without
  an invoice.
- A single payment settling two billing statements allocates correctly and produces one invoice
  covering both.
- A PDC does not settle a statement or issue an invoice until `clearedAt`; a bounced check
  reverses cleanly without leaving an orphaned invoice number.
- Service invoice numbering is gapless under 50 concurrent allocations; a cancelled invoice
  retains its number and is never reissued.
- Withholding: an account with `withholdsEWT` shows the expected net collectible; a payment whose
  withheld amount differs from expectation is flagged; a payment with withholding and no 2307
  appears on the chase list.
- Milestone triggers fire exactly once per event, and not at all for terms that don't include
  them.
- Final billing gate blocks on each unmet condition independently; override requires the
  permission and logs a reason.
- Partial payments allocate correctly across multiple invoices; over-allocation is rejected.
- Withholding tax reduces balance correctly and flags the missing 2307.
- Ageing buckets are correct across month and year boundaries and for `Asia/Manila` timezone,
  and run on billing statements rather than service invoices.
- Cash advance: VP approval is required at every amount; an extension approved by the VP moves
  the due date and is visible as an extension, not as an on-time liquidation.
- Project P&L reconciles: sum of all seven cost sources equals reported actual cost, to the
  centavo, with no double-count between a cash advance liquidation line and a field expense.
- Cash advance lifecycle: released → liquidated with a partial return reconciles released =
  spent + returned; an over-spend produces a reimbursable balance, not a negative return.
- Overdue liquidation blocks a new advance request for that person and releases the block on
  approval.
