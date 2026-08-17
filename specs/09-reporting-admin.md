# Module 09 — Reporting, Dashboards and Administration

**Depends on:** all. **Blocks:** nothing.
**Definition of done:** each role opens the app to a screen that tells them what to do today, and
management can answer "how are we doing?" without asking anyone to prepare anything.

---

## 1. Design constraint first

**Never run analytical aggregation synchronously in a request.**

This was originally argued from the DS220+'s two Celeron cores. The company confirmed on 2026-08-17
that the NAS is a **backup and recovery target only** and never a host, so that premise is gone — but
the rule survives it, for reasons that are now the real ones:

- **Serverless functions have a wall-clock limit.** On Vercel a dashboard that aggregates in-request
  does not get slower under load, it gets killed, and the user sees a 504 rather than a slow page.
- **The database is the shared resource, not the web tier.** Vercel scales out; Supabase Postgres does
  not. Five people opening dashboards that each scan the transaction tables is five concurrent
  sequential scans against one instance, and everything else in the app queues behind them.
- **A dashboard is read far more often than the data changes.** Recomputing per view is wasted work
  whatever the hardware.

So the thresholds move — seconds of function budget rather than a 2GB box — and none of the four
practices below change.

- Nightly job materialises fact tables: `FactSalesDaily`, `FactProjectMargin`,
  `FactQualityMetrics`, `FactCollections`, `FactUtilisation`.
- Dashboards read the materialised tables, not the transactional ones.
- Ad-hoc report builder queries run as **queued jobs** with a progress indicator and a
  notification when ready. Anything expected to exceed 3 seconds goes to the queue.
- Store computed KPI snapshots so historical trends do not require recomputing history — and so
  a KPI's value as reported at the time is preserved even if the underlying definition changes
  later. Auditors care about that.

---

## 2. Role dashboards

There are five people. Build five landing pages that match what those five people actually do,
and keep the generic role dashboards for future hires. Every widget must be answerable at a
glance and clickable through to the underlying records.

**EA — President.** Order intake vs delivery vs billing vs collection, four curves on one chart —
this shows where the business is stuck. Revenue and gross margin by month against last year.
Cash position: collected this month, AR ageing summary, outstanding cash advances. Quotation
conversion rate and average turnaround. Top customers by revenue and by margin. Anything blocked
more than five days anywhere in the system. QMS summary.

**KJ — Vice President.** **Quotations awaiting my approval**, and **cash advances awaiting my
approval**, at the top — these two queues are the company's critical path and they run through
one person. Margin variance, quoted vs actual, worst five projects. Expenses awaiting approval.
Pricing: quotes below margin floor, stale supplier costs, expiring price lists. Liquidations
outstanding and formally extended.

**PD — Admin Manager.** Accreditations due for renewal and documents expiring. **Government and
statutory compliance calendar** (§6b) — what is due in the next 60 days. Supplier RFQs sent
awaiting response, with age. Open admin tasks.

**DJ — Operations Manager.** Today's dispatch board. **Tickets blocked at a gate** — cash advance
unreleased, materials unissued, methodology not yet client-approved — with days blocked and who
owns the unblock. This is the single most useful widget in the platform for this company.
Tickets at risk. QA outcomes to record and rework outstanding. Service reports awaiting review.
Instruments at the calibration laboratory and due back. Capacity vs committed work, 4 weeks.

**EM — Sales and Marketing Manager.** Principal prospects by stage with next follow-up. Distributor
agreements and price lists expiring. Accounts not contacted in 60 days. Inquiry sources and
conversion by source. New product lines and their revenue contribution.

Keep the generic `technician`, `sales`, and `finance_officer` dashboards defined for when those
roles are filled.

## 3. Core KPI definitions

Define these once, in code, in `src/server/modules/reporting/kpis.ts`, so every dashboard and
export uses the same maths. Ambiguous KPIs computed three ways is how reporting loses
credibility.

| KPI | Definition |
|---|---|
| Quote turnaround | Median business hours from `inquiry.created` to first `quotation.sent` |
| Win rate | Quotations `accepted` ÷ (`accepted` + `rejected` + `expired`), by value and by count |
| Order intake | Sum of sales order totals by `orderDate` |
| Revenue recognised | Sum of issued invoices, excluding downpayments not yet earned |
| Gross margin (quoted) | From quotation at time of acceptance |
| Gross margin (actual) | Contract value − landed supplier cost − labour cost − field expenses − direct expenses |
| Margin variance | Actual − quoted, absolute and as percentage points |
| On-time delivery | Deliveries on or before `requiredByDate` ÷ total deliveries |
| First-time-right | Tickets closed with `reworkRound = 0` and no NCR ÷ total closed |
| Rework rate | Mean QA rounds per ticket, and % of tickets with ≥ 1 QA failure |
| Cost of poor quality | Rework labour + rework materials + warranty ticket cost + NCR cost impact |
| Gate delay | Median hours from `ticket.generated` to `ticket.ready_to_mobilize`, split by which gate held it (cash advance / materials / methodology / client approval) |
| Mobilization punctuality | Actual vs planned mobilization datetime |
| Delivery first-attempt success | Delivery tickets signed on attempt 1 ÷ total delivery tickets |
| DR signature lag | Median days from delivery to signed DR |
| Advance liquidation ageing | Outstanding advance value by days past liquidation deadline |
| Standby ratio | Standby hours ÷ total field hours, by cause code |
| Technician utilisation | Billable field hours ÷ available hours |
| DSO | Average days from invoice issue to full payment, trailing 90 days |
| Collection efficiency | Collected ÷ (opening AR + billed), monthly |
| NCR closure rate | NCRs closed within target ÷ NCRs raised, by severity |
| Supplier OTD | Supplier PO arrivals on or before `expectedArrivalDate` |

Every dashboard figure is **click-through to the underlying record list**. A number nobody can
drill into gets distrusted and then ignored.

---

## 4. Standard reports

Sales pipeline; quotation register (an ISO-friendly log of every quote, revision, and outcome);
sales order backlog; **ticket register by type and status**; **gate blockage report** (what held
each ticket, for how long, and who owned it — the report that tells management whether the
process is actually improving); project status summary; project P&L including rework cost;
QA and rework summary; T&C results register; **delivery performance report** with failed attempts
by cause and site; **cash advance and liquidation register** with outstanding ageing; tool custody
and outstanding returns; field service summary by technician and customer; installed base by
customer; warranty claim analysis by product and root cause; AR ageing and statement of account;
expense summary by category and project; supplier performance; quality metrics; calibration due
list; document master list; methodology library index.

All with: date-range and dimension filters, saved parameter sets, scheduled email delivery
(weekly Monday morning is the useful default), and export to XLSX/CSV/PDF.

---

## 5. Ad-hoc report builder

Deliberately constrained: a curated set of report subjects (Quotations, Sales Orders, Projects,
Tickets, Cash Advances, Material Requests, Deliveries, Invoices, Expenses, NCRs) with selectable fields, filters, grouping, aggregation, and
a chart type. **Not a SQL console.** Respects the caller's permissions and record scoping — a
salesperson building a report sees only their own records, and cost columns are unavailable
without `finance.view_cost`.

---

## 6. Administration

- **User management:** invite, deactivate (never delete), role assignment, permission overrides,
  session revocation, 2FA reset. Deactivation reassigns owned records via a guided flow rather
  than orphaning them.
- **Settings:** company profile, numbering formats, payment terms, VAT and FX defaults, approval
  thresholds, SLA targets, notification defaults, working calendar and Philippine holidays,
  module enable/disable.
- **Master data:** industries, product categories, units of measure, loss reasons, NCR
  categories, expense and cash advance categories, delivery failure cause codes, standby and
  delay cause codes, competencies, document categories, checklist templates, methodology
  templates, stock items, accreditation requirement templates, compliance items, laboratories,
  **payment terms (maintained by the VP)**.
- **System health:** queue depth and failed jobs with retry, backup status and last successful
  restore drill date, disk and database size, error log with request IDs, email ingest status.
- **Audit explorer:** search the audit log by actor, entity, action, and date range, with export.
  This is what you hand an auditor who asks "show me who changed this price."
- **Data import:** guided CSV import for accounts, contacts, suppliers, products, open
  quotations, and open projects, with column mapping, dry-run validation, an error report, and
  rollback of a failed batch. Needed for the initial migration off the spreadsheets — see
  Spec.md open question 10.

---

## 6b. Government and statutory compliance register (PD)

The Admin Manager handles government requirements. That is a calendar with documents attached,
and missing a renewal has real consequences — an expired mayor's permit can invalidate a customer
accreditation, which stops POs.

```prisma
model ComplianceItem {
  id, name, category    // registration | permit | licence | tax_filing | report | membership
  authority             // BIR, SEC, LGU, DOLE, PhilGEPS, PCAB, SSS, PhilHealth, Pag-IBIG
  referenceNumber?, issuedAt?, expiresAt?, renewalLeadDays
  frequency             // one_time | monthly | quarterly | annual
  nextDueAt, ownerId, status   // current | due_soon | overdue | lapsed | not_applicable
  documentIds String[], cost?, notes
}
model ComplianceEvent { id, itemId, action, dueAt, completedAt?, completedById, referenceNumber?, receiptFileId?, notes }
```

- Seed the common Philippine set: BIR registration and monthly/quarterly filings, SEC General
  Information Sheet, mayor's permit and barangay clearance, PhilGEPS, DOLE requirements, SSS /
  PhilHealth / Pag-IBIG remittances, and any PCAB licence.
- Reminders at the item's `renewalLeadDays`, escalating to the president when overdue.
- **Link compliance documents to customer accreditation** (module 01 §5b) so that renewing the
  mayor's permit automatically flags the accreditations that depend on it. That connection is the
  reason to build this here rather than in a spreadsheet.
- A one-page compliance status view — current, due soon, overdue — is also what a prospective
  customer's accreditation team often asks to see.

---

## 7. Tests

- Every KPI has a fixture-based test with a hand-computed expected value, including the gate-
  blocking and rework metrics across a ticket the client rejects at QA twice.
- Compliance: an item passing its lead-time flips to `due_soon` and notifies; an expired document
  flags every accreditation that depends on it.
- Report builder respects permission scoping — verified by running the same report as three roles
  and asserting different row counts.
- Materialised fact refresh is idempotent and correct after a partial failure and re-run.
- Import dry-run reports errors without writing; rollback leaves no partial data.
