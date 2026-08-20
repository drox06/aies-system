# Module 05 walkthrough — finance

A pass over everything module 05 added: the downpayment gate, the release queue, project P&L,
payables and the three-way match, and the accounting export.

Every step below says **what to do**, **what you should see**, and **what it would mean if you saw
something else**. Where a number is stated, it is the number the code should produce — if the screen
disagrees with this page, the screen is wrong until proven otherwise.

---

## Before you start

**Where:** https://aies-system.vercel.app — the live site, not localhost.

**Sign in as EA.**

**The sample deal is already seeded.** One job carries the whole walk:

| | |
|---|---|
| Account | `FIN5 Bataan Fertilizer` |
| Quotation | `AIESLQ264254` — PHP 708,960 gross, 30/70 terms |
| Sales order | `AIESSO-261298` |
| Project | `FIN5-PRJ-555760` |
| Ticket | `FIN5-TKT-555976` |
| Supplier PO | `FIN5-SPO-558566` — PHP 428,000, received in full |

Its money, once, so the figures below are checkable:

- Net of VAT **633,000** · VAT **75,960** · gross **708,960**
- Quoted cost **500,000** — two valves at 210,000 and a 80,000 installation lot

**Four things are deliberately not done**, because each is what a step asks you to do: the
downpayment, the advance release, the supplier bill, the export. **If any of them already looks done
when you get there, stop and tell me** — it means the seed did something it should not have.

**Have a notes app open.** For each problem: which screen, what you expected, what happened.

---

## 1. The downpayment gate (§4)

This wiring is one day old and was broken until this morning, so it gets the closest look.

**1.1 — Open the order.** Sales orders → `AIESSO-261298`.

- **Expect:** finance status **awaiting downpayment**, and the amount **PHP 212,688.00**.
- **The arithmetic:** 30% of 708,960. Nothing else.
- **If you see PHP 21,268,800** — 30× rather than 30% — stop. That was this morning's bug and it means
  the fix did not deploy.
- **If you see PHP 189,900** it read the net figure instead of the gross. Also a finding.

**1.2 — Check procurement is actually blocked.** Scroll to the supplier-ordering panel.

- **Expect:** ordering blocked, with a message naming the percentage (30%), the amount (212,688.00),
  and the fact that the President or VP can override with a reason.
- **The check that matters:** could somebody who has never seen this screen work out what to do next
  from the message alone? If it says "blocked" without saying who can unblock it, that is a finding.

**1.3 — Try to record it badly.** Press **Record the downpayment**, then:

- Leave the reference empty → **expect a refusal** naming the reference.
- Put a date in the future → **expect a refusal**. Money that has not arrived is not a payment.
- **If either goes through**, that is the finding — a downpayment recorded on a blank reference is
  procurement committing to a supplier on nothing.

**1.4 — Record it properly.** Reference `BDO deposit slip 4471902`.

- **Expect:** status moves to **downpayment received**.

**1.5 — Try to record it twice.**

- **Expect a refusal.** Two downpayments against one order is one of them being invented.

**1.6 — Back to the supplier-ordering panel.**

- **Expect:** the gate is now clear and ordering is available.
- **If it is still blocked**, the gate is reading a stale copy — that is the bug that made Delivery
  mode show yesterday's work.

> **Writes data.** Recording the downpayment is not undoable from the UI, on purpose — it states that
> money arrived. The removal command at the end clears it.

---

## 2. The release queue (§5b)

This screen answers *who is waiting for money and when do they need it*. The cash-advance register
answers *what is outstanding*. Different question, different sort order — that is why it exists
separately.

**2.1 — Open Finance → Releases.**

- **Expect:** the FIN5 advance near the top, **PHP 24,000.00**, marked **urgent**, needed tomorrow.
- **Why urgent and not "due tomorrow":** §5b reaches urgent a day early on purpose — banks close and
  cash has to be counted. An advance needed tomorrow is a problem this afternoon.
- **Question for you:** does that feel right, or does it cry wolf? If everything is always urgent,
  nobody reads the flag.

**2.2 — Look at the late count in the summary.**

- **Expect:** a **0**, shown rather than hidden.
- **The reasoning to agree or disagree with:** a figure that disappears when it is good is one nobody
  learns to read, so it stays visible at zero. Say if you would rather it vanished.

**2.3 — Release the advance.**

- **Expect:** it leaves the queue immediately.
- **Then check the cash-advance register** — it should still be there, now marked released. The queue
  is a view, not a place records go to disappear.

---

## 3. Project P&L (§6)

Open the project `FIN5-PRJ-555760`. The panel is near the top.

**This section has exact expected numbers.** They are computed from what the seed put on the job, so
any disagreement is a real finding.

**3.1 — The headline figures.**

| | Expect |
|---|---|
| Contract value | **PHP 633,000.00** |
| Quoted cost | **PHP 500,000.00** |
| Quoted margin | **PHP 133,000.00** — **21.0%** |
| Actual cost | **PHP 491,135.00** |
| Actual margin | **PHP 141,865.00** — **22.4%** |
| Variance | **+1.4 points** |

- **The one to check hardest is contract value.** It should be **633,000**, the figure net of VAT —
  *not* 708,960. VAT is collected for the BIR, not earned, and counting it as revenue flatters every
  job by about twelve per cent. That was a bug until this afternoon.
- **Cross-check:** open the quotation `AIESLQ264254` and look at the margin it states. It should say
  **21.0%** too. If the two screens disagree about the same deal, that is the finding — and it is the
  exact shape of the bug that was fixed.

**3.2 — The cost breakdown.** All eight categories should be listed.

| Category | Expect |
|---|---|
| Materials and goods | **434,800.00** — 428,000 supplier PO + 6,800 of gaskets |
| Labour | **10,335.00** |
| Subcontractors | **46,000.00** — the crane and riggers |
| Equipment and rental | 0.00 |
| Travel and site costs | 0.00 |
| Permits and fees | 0.00 |
| Rework | 0.00 |
| Other | 0.00 |

- **The zeros must be shown, not omitted.** "We spent nothing on subcontractors" and "nobody has
  entered the subcontractors yet" look identical if the row is missing, and only one is good news.
- **If a category is missing from the list entirely**, that is the finding.

**3.3 — The caveats. This is the most important thing on the screen.**

- **Expect:** a caveat saying **one day has no cost rate**.
- **What it is:** KJ worked a day on this job and KJ has no cost rate on file, so the day is counted
  as **uncosted** rather than as free. That day is genuinely missing from the 10,335.
- **The check, and please answer it directly:** does the wording tell you *what to do*? It is only
  useful if you can get from it to "somebody needs to enter a rate for KJ". If it reads like a
  footnote rather than an instruction, say so — that phrasing is the whole point of the caveat.

**3.4 — Rework.**

- **Expect:** a **count of failed QA rounds**, which is **0** here, said out loud rather than blank.
- **Why a count and not pesos:** what a failed round actually costs is the crew going back — labour
  and travel already counted above. Splitting it out needs a link from a timesheet to the QA round
  that caused it, which module 04 does not record and should not be made to guess.
- **Question for you:** is a count enough, or does the company need the peso figure badly enough to
  justify building that link?

**3.5 — Permissions.** If you can, open the same project as somebody without cost permission.

- **Expect:** costs and margin **absent**, not shown as zero. A zero margin and a hidden margin are
  different statements.

> **Reads only.** Nothing on this screen writes.

---

## 4. Payables and the three-way match (§7)

The match compares a bill against **what we ordered** and **what we actually received**. On
`FIN5-SPO-558566` those two agree — 428,000 ordered, both valves received — so you can produce either
outcome by choosing what to bill.

**4.1 — Open Finance → Payables.**

- **Expect:** no FIN5 bills, because none has been recorded. Whatever else is on the list is from
  earlier work.

**4.2 — Record a matching bill** against `FIN5-SPO-558566`:

- supplier reference `LVS-INV-88221`, amount **428,000.00**, invoice date today, due in 30 days.
- **Expect:** status **matched**, no findings.
- **Then clear it for payment** — **expect one press, no reason asked**. The system did the checking;
  making a person retype that adds nothing.

**4.3 — Record the same reference again.** `LVS-INV-88221`, any amount.

- **Expect a refusal**, naming the bill it is already recorded as.
- **Why refused rather than warned:** a supplier billing the same reference twice is the commonest
  duplicate-payment cause there is, and there is no legitimate version of it — the right action is
  always to go find the existing record.

**4.4 — Record a bill that does not match.** Reference `LVS-INV-88222`, amount **461,000.00**.

- **Expect:** status **disputed**, with a finding of kind **price** saying what was expected
  (428,000) and what arrived (461,000).
- **The check:** could you ring the supplier holding only this screen? "Disputed" tells you to look.
  It should also tell you what to say. A price rise and goods that never came look identical on a
  summary and are two completely different conversations.

**4.5 — Try to clear the disputed one.**

- **Expect:** it demands a written reason of at least ten characters.
- **The check:** is it asking the right question? It should be asking *what was checked*, not merely
  "why" — an unexplained override is indistinguishable from nobody looking.

**4.6 — Approve it with a real reason**, e.g. "Freight increase agreed by phone with Rosa on 18 Aug."

- **Expect:** the reason visible on the row afterwards, not buried in an audit log.

**4.7 — The ageing buckets.**

- **Expect:** the same five buckets as §5's receivables — not due, 1–30, 31–60, 61–90, over 90.
- **The check:** open the receivables screen alongside it. "We are owed X at 60 days and we owe Y at
  60 days" should be a comparison you can make at a glance. If the buckets or the layout fight each
  other, that is a finding.

> **Writes data.** Three supplier bills, all removed with the sample deal.

---

## 5. The accounting export (§8)

Three steps rather than one button, and **the middle step is the entire point**.

**5.1 — Open Finance → Accounting export.**

- **Expect:** it defaults to **last month**, because that is what somebody opening this screen almost
  always wants.
- **Expect:** the history below shows **nothing from today**. Opening this screen must not count as an
  export — if a run appears that you did not make, that is a bug and a serious one, because then the
  answer to "has August been done" is yes the moment anybody asks.

**5.2 — Preview.** Choose **Supplier bills**, layout **Generic**, a period covering today.

- **Expect:** a row count shown **before** anything downloads. It should be **2** — the matched bill
  and the disputed-then-approved one; the duplicate was refused and never recorded.

**5.3 — Download it** and open the CSV.

- **Expect:** amounts in **pesos with two decimals**, not centavos. 428,000.00, not 42800000.
- **The check:** would whoever does AIES's books recognise these columns?

**5.4 — Run exactly the same period and dataset again.**

- **Expect:** a warning **before** downloading, saying this period has been exported and the contents
  are **identical** to the last run.
- **Expect it to warn, not refuse.** Both kinds of repeat are legitimate — the accountant lost the
  file, or a late invoice means the month genuinely needs resending — and a flat refusal just gets
  worked around by exporting under a different filename, which loses the record entirely.
- **Question for you:** agree, or should it refuse?

**5.5 — Change the data, then repeat.** Record one more supplier bill, then run the same period again.

- **Expect:** the warning now says the contents have **changed** since the last run.
- **Why the distinction matters:** an identical repeat would double the month in the accounts; a
  changed one needs the difference posting or the earlier entry reversing. Two different problems,
  two different fixes, and "already exported" alone leaves somebody guessing which.

**5.6 — Try the other layouts.** QuickBooks and Xero on the same data.

- **These are my guesses at what those systems want.** If AIES uses one of them, this is the step
  where you tell me the real column names — I cannot get that right without you.

**5.7 — Two refusals to confirm.**

- A period whose **end is before its start** → expect a refusal.
- A period with **no data** → expect the download button disabled, with a reason. An empty CSV is
  something somebody might post.

---

## 6. Across all five screens

**Money alignment.** Every peso figure right-aligned, tabular figures, columns lining up. Note any
screen where they do not.

**Empty states.** A screen that can be empty must say **why**. "No supplier bills are outstanding" is
an answer; a blank panel is not. Check each of the five with fresh eyes.

**Wording you would not say out loud.** If a message reads like it was written by the system rather
than by a colleague, note it. Most of these were written once and never read back.

---

## When you are done

Send me the list — including the direct questions in 2.1, 3.3, 3.4, 4.7, 5.4 and 5.6, which I need
answers to rather than approval.

Then to take the sample deal back out:

```bash
cd C:\dev\aies
```

```bash
$env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-finance.ts --remove
```

That removes the account, the deal, the project, the costs, the advance, the supplier order and every
bill you recorded against it. It deliberately **leaves the export runs**, because those record
something that actually happened and §8's whole point is that they do not quietly disappear.
