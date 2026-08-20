# Module 05 walkthrough — billing, invoicing, collections

Covers §2's billing schedule, §3's two documents, §4's final gate and §5's receivables — the half of
module 05 that had never been walked, and which had no screens until 2026-08-20.

Live site, signed in as EA. Seed `BILL7` is loaded.

| | |
|---|---|
| Order to bill | `AIESSO-261561` — Progress billing |
| Customer | `BILL7 Davao Agri Processing` (withholds 2% EWT) |
| Debtor | `BILL7 Zamboanga Canning` — three statements, 15 / 45 / 80 days overdue |

---

## 1 · The billing plan (§2)

**Where:** Sales orders → `AIESSO-261561`. New **Billing** panel below the header.

| Check | Expect |
|---|---|
| Panel present | Three milestones from the Progress billing term |
| Mobilisation advance | **₱229,420.80** · 20% · `ready_to_bill` |
| On commissioning accepted | **₱573,552.00** · 50% · `pending` — *"Waiting on: …"* |
| Final on close-out | **₱344,131.20** · 30% · `pending` |
| Why each is billable | A line on every row, not just the ready one |

**The point:** the two pending ones are shut because the work has not happened. If they were billable
here, §2 would be meaningless.

**Also try:** *Cancel this milestone…* on a pending one — demands a written reason, and warns that the
plan will no longer add up to the order.

---

## 2 · §4's final billing gate

**Where:** same panel, below the milestones.

| Check | Expect |
|---|---|
| Heading | **Final billing** with **Not yet** |
| Conditions | All seven listed, ticked or not — not just the failures |
| Each unmet one | Names what is missing **and who owns it** |
| Wording | Says the President or VP can override with a reason |

**The point:** this list is what a customer points at when disputing a final bill. It should read as
evidence, not a to-do list.

---

## 3 · Raise and issue a statement (§3)

**Where:** Finance → **Ready to bill**.

| Step | Expect |
|---|---|
| Find the milestone | Mobilisation advance, ₱229,420.80 |
| **Raise a statement** | Description pre-filled and editable; amount fixed, with a note saying to change the milestone instead |
| Raise it | A **draft** — nobody has been asked for anything yet |
| Finance → **Statements** → Drafts | Your statement, total **₱256,951.30** (229,420.80 + 12% VAT) |
| Note at the top of the page | Statement vs service invoice, and that invoices issue on payment |
| **Issue it** | Moves to **Open**. It is now a receivable |
| Withholding line | *"Customer withholds ₱X — expect ₱Y to arrive, plus a 2307"* |

**Also try:** *Cancel it…* on a draft — needs a reason, and says the statement is kept, never deleted.

---

## 4 · A bank transfer, and the invoice it issues

**Where:** Statements → Open → **Record a payment**.

| Step | Expect |
|---|---|
| Method **Bank transfer** | Amount pre-filled with the **net** expected, not the total |
| Withholding field | Pre-filled with the expected figure |
| Type a different withholding | An **amber warning**, not a refusal |
| Record it | Toast **names the service invoice** — `AIESSI-…` |
| Statement row | Shows the invoice as a link |
| Click the invoice number | **The PDF opens** — VAT breakdown, both TINs, EWT deducted |
| Statement status | **partially_paid** — the withheld amount is still outstanding |

**The PDF is the thing to scrutinise.** It is a BIR document. Check the VAT block, both TINs, and
that "total due → less withheld → net received" is the order your accountant expects.

---

## 5 · A cheque — the one that matters most

**Where:** Statements → any open statement → **Record a payment**.

| Step | Expect |
|---|---|
| Method **Cheque**, a cheque number, a **future** cheque date | Form asks for both |
| Record it | Toast says recorded and **no invoice yet** |
| Top of the page | **Cheques not yet cleared** — your cheque, marked *post-dated, not yet due* |
| The statement | **Not** settled |
| Press **It cleared** | *Now* the service invoice issues |
| Press **It bounced** on another | Demands what the bank said |

**If a cheque ever issues an invoice on recording, stop and tell me.** That is a VAT liability on
money that may bounce — §3.3's central warning.

---

## 6 · The 2307 closes the statement (§3.2) — your option A

**Where:** Finance → **Receivables** → the amber *2307* panel.

| Step | Expect |
|---|---|
| Panel | Your withholding payment listed, with days outstanding |
| **The 2307 arrived** | Asks for the date it *actually* arrived, not today |
| Record it | Toast says how much was credited, across how many statements |
| Back to Statements | The statement is now **paid**, balance **zero** |

**The point:** before the form, AIES has neither the cash nor the credit, so the shortfall keeps
ageing. After it, the statement closes. That was your ruling.

---

## 7 · Voiding an invoice

**Where:** Statements → next to any service invoice number → **void…**

| Check | Expect |
|---|---|
| Reason | Required |
| Wording | Says the number is not reused, the document still prints, and the reason is what BIR is shown |
| After voiding | Invoice shows **(cancelled)** in red; the PDF still opens, marked CANCELLED |

---

## 8 · Receivables and collections (§5)

**Where:** Finance → **Receivables**, then **Collections**.

| Check | Expect |
|---|---|
| Ageing buckets | Zamboanga's three statements at **1–30**, **31–60**, **61–90** |
| Ageing is on statements | Not on invoices — an unpaid bill has no invoice behind it |
| Collections worklist | The overdue ones, oldest first |
| Log a call | Records who, when, what was said, and any promised date |

---

## What is deliberately still missing

Three procedures have no screen, and each for a stated reason:

- `collectionHistory` and `setRemindersEnabled` — belong on a collections row, next session
- `creditExposure` — §5 wants it checked when a **new order** is raised, which is module 03's screen

Run `npx tsx scripts/unreached-mutations.ts` at any time to see the current state.

---

## When you are done

```bash
$env:ALLOW_DEMO_DATA = '1'; npx tsx scripts/sample-billing.ts --remove
```

Service invoice numbers the walk consumed are **not** reclaimed. §3 keeps the BIR series accountable:
a number issued stays issued.
