# What the people using it have told us

Every comment from a real user, kept verbatim with the date and the person, plus what I understand
it to mean. Nothing here has been acted on — the company's decision of 2026-08-22 is to collect a
week of use first and then decide what to cut.

**Why verbatim.** A finding paraphrased into a ticket loses the thing that made it worth having.
"Cannot edit the note on a task" and "enable editing of assigned tasks" are the same defect described
twice, and it is only obvious that they are the same because both are written down as they were said.

**Why the interpretation is kept separate.** Mine is a guess until somebody confirms it. Where I have
a hypothesis about the cause it is labelled as one.

---

## 2026-08-21 — EA, first walkthrough

Fifteen findings from the first end-to-end pass.

| # | Verbatim | Reading |
|---|---|---|
| 1 | Task assigned as urgent does not notify assigned person | Bug. `createTaskService` never passes `urgent: true` to `notify`, so §7's exemption cannot fire. Compounds with #11 |
| 2 | Enable editing of assigned tasks | Missing. A task can be reassigned and moved between statuses; its title and description cannot be changed at all. **Reported again by PD on 2026-08-25** |
| 3 | Give PD authority to add new clients and process customer accreditation | Permission. Possibly a stale session — the president role was granted the same day and permissions are read at sign-in |
| 4 | Add service work in log inquiry | Missing. The inquiry takes items; service scope has nowhere obvious to go |
| 5 | EM needs authority to quote and request supplier pricing | Permission. Same stale-session caveat as #3 |
| 6 | Draft request for pricing "we would like to request for your best price" | Copy. The RFQ draft wording |
| 7 | Add additional header percentage of the subtotal (not visible on quote, but visible on costing) | Missing. A markup or contingency line that the customer must not see |
| 8 | Show discount on quote | Missing on the document |
| 9 | Removed PO, entered new PO but it says already have PO | Bug. The "already has a PO" check almost certainly does not exclude the soft-deleted one |
| 10 | Item proceed to delivered with the GRN approval | Flow. Delivery is expected to follow the goods receipt and does not |
| 11 | Notifications do not work | Not reproducing in the data as of 2026-08-25: nineteen jobs succeeded, three notifications delivered, none held by quiet hours. Needs a specific case |
| 12 | Create inspection report based on site inspection | Missing document. **Reported again by DJ on 2026-08-25** |
| 13 | Make terms and conditions of quote able to be rearranged | Missing. Ordering |
| 14 | Arrange spacing of draft method statement | Layout |
| 15 | Needs buying has no next action | Dead end. A state with nothing to press — the recurring fault of this project |
| 16 | Service report cannot be downloaded | Missing document |

---

## 2026-08-25 — DJ, operations

> **1. Nothing to display on "my works" for DJ**

Correct behaviour, and that is the problem. All fourteen task templates fire on events from the
second half of the arc — a sales order created, tickets generated, an advance requested. None has
happened, so nothing is assigned to DJ. Meanwhile DJ has been the busiest person in the system all
week. **The operations manager's main screen is empty during the half of the job he actually does.**

> **2. Lessen the forms in the operations, focus on inspection report, service report, and testing
> and commissioning.**

The strongest simplification signal so far, and from the person who owns that module. Module 04
currently has site inspection, methodology, material request, mobilisation, daily progress, QA
approval, T&C, service report, close-out, warranty, delivery, checklists and timesheets. DJ names
three.

The tension to resolve rather than ignore: several of those forms carry gates the company has said
must not be weakened — client approval of the method statement, mobilisation readiness, the QA
verdict. **A gate does not have to be a form.** The methodology gate could be a date and a file on
the ticket rather than a document builder. That distinction is probably where most of the cut lives.

> **3. Be able to generate an inspection report after conducting site inspection.**

Second time this has been raised (see #12 above). Sits with "service report cannot be downloaded" in
one family: the platform captures the data and produces no document. For a company whose deliverable
to the client often *is* the report, that is not a nice-to-have.

---

## 2026-08-25 — PD, admin

> He was making a task and when he needed to edit the note part in the task he cannot perform the
> edit.

Confirms #2 above, and narrows it: the **description** is the field that matters, not the title.

Worth noting what PD is using tasks *for*: statutory HR administration — SSS, Pag-IBIG and PhilHealth
enrolment for EMC. That is outside the inquiry-to-payment arc entirely, and it is the clearest signal
in the whole log about what people reach for unprompted: a plain place to keep office work, editable
like a note.

**Hypothesis:** `task-service.ts` exposes create, assign and status change, and nothing that edits
`title` or `description` after creation. A task's own text was treated as fixed at the moment it was
raised, which is right for one a template generated and wrong for one a person is drafting.

---

## 2026-08-25 — KJ, vice president

> Tried to log a new item inquiry, cannot produce site inspection ticket or order to DJ to conduct
> the site inspection.

Notable because KJ **did** succeed at this on 24 August: `AIESSIR-260001` is scheduled for the 27th
against `AIESINQ-260001`. So something differs between the two attempts.

**Two hypotheses, both cheap to confirm and neither confirmed:**

1. **The assignee list is filtered to technicians, and nobody holds that role.** Active holders on
   2026-08-21: `sales` 0, `technician` 0, `viewer` 0. If the inspection request offers only
   technicians, the list is empty and there is nobody to send it to — DJ is `operations_manager`.
2. **The action is gated on the inquiry's status.** `AIESINQ-260001` had been moved to *evaluating*
   before KJ acted; a brand-new inquiry sits at *new*, and the request may not be offered there.

The second reading also explains the status thrashing on 260001 — five transitions in fifteen
seconds, then three reversals across three people over seventeen hours. If moving the status is what
reveals the button, people will move the status until the button appears.

**The wider point:** KJ describes wanting to *"order DJ to conduct the site inspection"*. That is an
assignment of work to a colleague. The platform models it as a request attached to an inquiry, aimed
at a technician. Those are not the same act, and the mismatch is worth settling before either is
built on.

---

## 2026-08-28 — KJ, vice president

> All tasks assigned to DJ are not in DJ's app.

**Two readings, and the data says both are true.**

*The literal one:* nothing is assigned to DJ. Every one of the six tasks raised on 27–28 August is
assigned to **KJ** or **EA** — four to KJ, raised by KJ, and two to EA, raised by KJ. DJ has zero.
So either the assignee picker defaulted to the person raising the task and the choice did not take,
or KJ raised them for himself believing otherwise. Worth watching him do it once.

*The one that is probably meant:* KJ **did** assign DJ three things — the site inspections on all
three inquiries, all scheduled, all naming DJ. Those are `InspectionRequest` records, not tasks, so
**they cannot appear on My Work at all.** DJ has six notifications about them and nothing on the one
screen that is supposed to answer "what am I supposed to be doing".

That is the same fault DJ reported on the 25th from the other side, and together they make the
strongest architectural finding of the fortnight: **work assigned to a person through an inspection
request never reaches that person's work list.** The platform has at least three ways to give
somebody something to do — a task, an inspection request, and a ticket — and only one of them shows
up in My Work.

> The task given to me did not have any notifications even though its timing is urgent.

`AIESTSK-260005 — Process Payment to Hearken`, priority **urgent**, raised by KJ at 22:17 Manila and
due the next day.

The notification exists, was created at the right moment, and was **not held** by quiet hours —
`heldUntil` is null on both of EA's task notifications. So the quiet-hours feature is not the cause,
and the earlier suspicion that it might be is wrong.

What is left is that the bell showed it and nobody looked, or that the bell did not surface it
visibly enough at 22:17 on a phone. Confirms **finding #1 of 2026-08-21** from a different angle:
`createTaskService` never passes `urgent: true` to `notify`, so an urgent task is delivered exactly
like an ordinary one — same bell, same silence. Marking a task urgent currently changes how it
**sorts** and nothing about how it **reaches** anybody.

Five of the six tasks raised were marked urgent. If urgency does not change delivery, it will stop
being used.

---

## 2026-08-28 — DJ, operations

> He wants to remove most of the items in the ticket, such as mobilization readiness. For now he
> only needs a template for site inspection report. The rest will follow the site inspection.

Sharpens his comment of the 25th from "lessen the forms" to a specific instruction and a specific
order of work: **start with the site inspection report template; everything else waits until that is
in use.**

Named for removal: mobilisation readiness, and "most of" the rest of the ticket panels.

**The thing to settle before acting on it.** Mobilisation readiness is not only a form — it is the
gate that refuses to send a crew out before the downpayment is in, the client has approved the method
statement, and the materials are issued. Removing the panel is easy; removing the check is a decision
about money. The likely resolution is the one already noted on the 25th: **a gate does not have to be
a form.** Readiness could be three lines of text on the ticket that go red, with no screen of its own.

Worth putting to DJ directly: *when you say remove mobilisation readiness, do you mean the form, or
do you mean the crew should be able to go out regardless?* Those are very different requests and the
answer decides how much of it can go.

**And the sequencing is a gift.** "The rest will follow the site inspection" says the first thing to
build is a document template, not a workflow — and that is exactly the family of finding that keeps
recurring: the platform captures data and produces no paper.

---

## Standing gap: refusals are invisible

The audit log records what **succeeded**. A gate refusing somebody, a validation message, a 403, a
screen opened and abandoned — none of it writes a row. Every entry above exists only because a person
remembered and typed it out.

For a week whose entire purpose is finding friction, the most valuable moments are the ones leaving
no trace. Recording refusals would be a small change. Raised 2026-08-25, not yet actioned.
