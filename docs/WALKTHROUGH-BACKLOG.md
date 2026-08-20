# Walkthrough backlog

**What this is.** From 2026-08-21 the build runs straight through to module 10 without stopping for a
walkthrough after each module — EA's decision, taken knowingly. This file is the compensating
control: every session that ships something a person can press records here **what to walk, where to
go, what to expect, and which seed sets it up**, at the moment it is fresh.

**Why it exists.** Every defect this platform has produced was found by a person using a screen, and
none by the suite — 1,700 tests have never caught one. Parking the walks does not lower that rate; it
defers discovery. What this file prevents is the second cost: reconstructing, four modules later,
what each screen was supposed to do and how to get a job standing in front of it.

**How to use it.** Take one module at a time. Run its seed, follow the sheet, tick or report. Remove
the seed afterwards with `--remove`. Nothing here needs doing in order, except that a module's own
sheet assumes its seed and no other.

Seeds are guarded by `ALLOW_DEMO_DATA=1`, prefix every record they create, and remove what they
became — not merely what they wrote.

---

## Status at a glance

| Module | Walked? | Sheet | Seed |
|---|---|---|---|
| 00 Foundation | ✅ review gate passed 08 Aug | — | — |
| 01 CRM & Inquiry | ✅ review gate passed 09 Aug | — | `sample-records.ts` |
| 02 Quotation | ✅ walked, tagged 15 Aug | — | — |
| 03 Order & Procurement | ✅ accepted 20 Aug | — | `sample-payables.ts` |
| 04 Operations & Projects | ⚠️ accepted 20 Aug, **but nine gaps were built after the tag** | below | `sample-records-dispatch.ts`, `sample-warranty.ts` |
| 05 Finance & Billing | ✅ both halves walked 20 Aug, all good | `WALKTHROUGH-MODULE-05.md`, `WALKTHROUGH-MODULE-05-BILLING.md` | `sample-finance.ts` (FIN5), `sample-billing.ts` (BILL7) |
| 06 Collaboration | ⬜ **parked** | below | none yet — session 1 needs no seed |
| 07–10 | ⬜ not built | | |

---

## Module 04 — the nine controls built after the tag

`module-04-complete` points at `9b08e4d`, and sessions 16–17 landed **after** it. At the tagged commit
a timesheet could not be approved, leave could not be recorded, a callout could not be raised. So the
acceptance is real and does not cover these:

| Where | What to press | Expect |
|---|---|---|
| `/timesheets` | Approve a submitted timesheet, and an expense | Hours reach §6's labour cost — before this, every project's largest cost line read **zero** |
| `/timesheets` | Look at a row waiting over two working days | Marked escalated. The admin manager and VP could always act; escalation widens who is *chased*, never who is *allowed* |
| `/cash-advances/[id]` | Send a draft for approval | A draft could be created and never asked for |
| `/dispatch` → Who is away | Record leave | The board stops scheduling somebody who is not coming in |
| `/dispatch` → Emergency bump | Reschedule an emergency | It says what gets displaced, in the same act |
| `/tickets` → Raise a callout | Raise work with no sales order behind it | A whole category of after-sales that had no entry |
| `/store` → Record a count | Correct a stock quantity | §7's material gate decides against that number |
| `/contracts` → Write a contract | Create one | §16's renewal loop had no way to start |
| `/checklists` → New checklist | Create a twelfth template | Only the eleven seeded ones existed |
| `/cash-advances/[id]` | Liquidation reconciliation, and the queue of what is awaiting check | Whether an advance's money balanced, findable without already knowing which advance to open |

---

## Module 05 — what is left, which is not the features

Both halves were walked on 2026-08-20 and reported all good — §4's downpayment gate, §5b's release
queue, §6's P&L, §7's payables, §8's export, and then §2's schedule, §3's statement and service
invoice, §4's final gate, §5's receivables, cheques and the 2307. What remains is not a walk:

- **The review gate and the tag.** EA's, per BUILD-PROTOCOL §7.3.
- **Three procedures still have no screen**, each for a stated reason: `collectionHistory` and
  `setRemindersEnabled` belong on a collections row; `creditExposure` belongs on module 03's order
  screen, where §5 wants it checked as a new order is raised.
- **Both walkthrough seeds are still live** — `FIN5 Bataan Fertilizer`, `BILL7 Davao Agri Processing`,
  `BILL7 Zamboanga Canning`, with 4 statements and 2 BIR-numbered service invoices among them. Left
  in place deliberately: removing them would make the parked walk unresumable. They go at the
  clean-slate cutover, or sooner on request:

  ```bash
  $env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-billing.ts --remove
  ```

  Service invoice numbers the walk consumed are **not** reclaimed. A number issued stays issued.

---

## Module 06 — session 1: My Work and the task

No seed needed. Raising a task by hand is the first thing the screen offers, which is also the thing
to test.

**Where:** the sidebar's first entry, **My Work** (`/my-work`).

| Step | Where | Expect |
|---|---|---|
| Open it cold | `/my-work` | *"Nothing is assigned to you"* — stated as genuinely empty, not blank |
| Raise a task, leave the owner as **Mine**, no due date | Raise a task | Lands under **No date agreed**, at the bottom, counted in the summary — not treated as urgent, not hidden |
| Raise one due yesterday | Raise a task | Lands under **Overdue**, above everything |
| Raise one marked **Urgent** due next month | Raise a task | Sits *below* the overdue one. Priority breaks ties inside a band and never jumps one — the rule to check by eye |
| Raise one attached to a **Ticket**, pasting the id from a ticket's URL | Raise a task | Row carries an *"Open the Ticket"* link that lands on that ticket |
| Assign one to the test finance account | Raise a task → Whose is it | That account gets a bell notification naming the task number |
| Open the ticket you attached to | `/tickets/[id]` | A **Tasks** panel above History, with the task, the owner's name and its due date |
| Mark it done from the ticket panel | Tasks panel → Mark done | Leaves My Work. Finished work is not owed |
| Set a task to **Cancelled**, then try to move it back | My Work → status dropdown | Refused: *"raise a new one, so the reason this was dropped survives"* |

**What is deliberately not here yet:** boards, the thirteen event-fired templates, channels, the
calendar, quiet hours. Sessions 2–6. A task today arrives because a person raised it.
