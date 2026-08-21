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
| 06 Collaboration | ⬜ **parked** | below | none yet — sessions 1–4 need no seed |
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

---

## Module 06 — session 2: templates fired by events

Still no seed. The point of this session is that tasks arrive **without anybody raising them**, so the
walk is to make a real thing happen and watch the work appear.

**Where:** `/tasks/templates`, then `/tasks`.

| Step | Where | Expect |
|---|---|---|
| Read the templates | `/tasks/templates` | Fourteen, each naming its trigger, who it goes to, and when it is due. The three assignment modes are explained at the top |
| Raise a real sales order | Quotations → a won quotation → record the PO | Within a drain cycle, four tasks exist: acknowledge the PO, generate the tickets, raise the supplier PO, raise the downpayment invoice |
| Look at who got them | `/tasks` | Acknowledge-the-PO is **unassigned** — nobody holds `sales`. The other three name a real person |
| Assign the unassigned one | `/tasks` → the dropdown on that row | It leaves "Nobody owns these" and appears on that person's My Work |
| Check the dates | `/tasks` | Due dates are working days out, never a Saturday |
| Fire the same event twice | Re-run the drain, or re-record | **No duplicates.** The count stays at four |
| Turn a template off | `/tasks/templates` → Turn off | It stops raising work. The audit trail on the template records who turned it off and when |
| Change an assignment mode | `/tasks/templates` → the dropdown on a line | Saved, audited, and the next firing uses it |
| Request a cash advance | `/cash-advances` | The approval task is due **when the money is needed**, not a fixed number of days out |
| Release it | Finance → Releases | A liquidation task lands on **the person who requested it**, dated from the liquidation due date |

**Known and deliberate:** six templates assign to `sales` or `technician`, which nobody currently
holds, so their work arrives unassigned. That is the correct behaviour and the reason `/tasks` leads
with unassigned work — but it is also a prompt to decide who holds those roles before go-live.

---

## Module 06 — session 3: boards

**Where:** the sidebar's **Boards**.

| Step | Where | Expect |
|---|---|---|
| Make a board arranged by hand | `/boards` → New board → *Arranged by hand* | Five columns: To do, In progress, Blocked, For review, Done |
| Put a task on it | Open it → *Put a task on it* | Every open task not already on the board is offered |
| Drag a card to **In progress** | The board | It moves **and the task's status changes with it** — check the task on My Work |
| Do the same on a phone | The board | No dragging needed: each card has a column dropdown that does the identical move |
| Set a WIP limit of 1 on In progress | Settings → How many at once | Put two cards there. The header goes **red** and says *2 / 1 over* — and the move is still allowed, deliberately |
| Turn on a lane per person | Settings → Rows | The board splits into rows, one per owner, with unowned work in its own lane |
| Make a board that keeps itself current | `/boards` → New board → *Keeps itself current*, Whose = **Mine** | It fills with your own open tasks without anything being dragged |
| Try to drag on that board | The smart board | Refused, with the reason: what is on it is decided by its filter |
| Open the same smart board as the test finance account | The smart board | **A different set of cards** — one board, each person's own work |
| Make one with *Only what is past its date* | New board | Undated tasks do **not** appear. They are uncommitted, not late |
| Delete a board with cards on it | Settings → Delete board | The dialog says the tasks are not deleted. Check afterwards: they are still on My Work |

**Known and deliberate:** the smart-board filter asks about **tasks**, not records. "All quotations
awaiting my approval" is the Approvals screen; a board that duplicated it would be a second answer to
the same question. docs/DECISIONS.md #141.

---

## Module 06 — session 4: channels

**Where:** the sidebar's **Channels**.

| Step | Where | Expect |
|---|---|---|
| Open a channel | `/channels` → New channel | It exists and you are already in it |
| Name a colleague with `@` | The composer | They get a bell naming you and the channel |
| Name somebody whose first name is another person's whole name | The composer | **Only** the person you named is notified — the bug this was built with, DECISIONS #143 |
| Type a real document number, e.g. `AIESSO-261561` | The composer | The message carries a card that opens that order |
| Type a number that does not exist | The composer | Stays plain text. No dead card |
| Reply in a thread, then reply to the reply | Any message → Reply | Both sit in the **same** thread. Threads are one level deep |
| Set *Only when I am named*, have somebody post | The dropdown by the heading | No bell for an ordinary message; a bell for `@here` and for being named |
| Set *Nothing*, have somebody `@here` you | The dropdown | **No bell.** Your own setting wins |
| React, then react again with the same emoji | Any message | It toggles off and disappears entirely |
| Edit a message within fifteen minutes to name somebody new | Any own message | Marked *edited*; the newly named person is **not** notified |
| Try to edit after fifteen minutes | Any own message | Refused, with the suggestion to post a correction |
| **Make a message a task** | Any message → Make it a task | A real task is raised with the message inside it, and a reply appears saying which number |
| Search a word | `/channels` → Search | Finds it. A private channel you are not in is never searched |
| Archive a channel | Channel → Settings → Archive it | Nothing more can be posted, by anybody. Everything stays readable |
| Close a project that has a channel | `/projects` | Its channel archives itself and stays on the list under **Archived** |

**Known and deliberate:** no attachments yet — §3 routes them through module 07's DMS, which is not
built. Everything else in §3 is here.
