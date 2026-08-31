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

**Confirmed by EA on 2026-08-28: KJ meant the inspection requests.** He assigned the three site
inspections to DJ and was checking whether they landed on DJ's My Work. They did not, and cannot —
an `InspectionRequest` is not a `Task`, and My Work reads tasks. DJ received six notifications about
them and has an empty work list.

There is no assignee-picker fault. The six tasks raised on 27–28 August are KJ's own four and EA's
two, assigned exactly as intended; my first reading of this finding was wrong and is withdrawn.

**What is left is the sharper finding, and it is the most important one of the fortnight.** KJ's
mental model is *"I gave DJ a job."* He did not distinguish between an inspection request, a task
and a ticket, and had no reason to — from where he sits they are one act. The platform has at least
three separate mechanisms for giving a person something to do, and **only one of them reaches the
screen that answers "what am I supposed to be doing".**

This is the same fault DJ reported from the other side on the 25th: his My Work is empty while he is
the busiest person in the system. Two people, two directions, one cause.

**For the simplification:** this is a strong argument that the inspection request, the ticket
assignment and the task should collapse into one thing, or at minimum that everything assigned to a
person must appear on their work list regardless of which record carries it. It also explains why
KJ reached for tasks to track his quotations — a task is the only thing he can be sure somebody will
see.

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

## 2026-08-31 — found in the log, not reported by anybody

Two faults nobody mentioned. Both matter because of that: DJ worked around the first and lost ten
minutes to it without saying a word, which is a fair measure of how much friction never reaches us.

### iPhone photos do not work

At 12:55 Manila, DJ uploaded seven site photographs to the inspection on `AIESINQ-260003`, straight
off a phone: `IMG_2041.HEIC` through `IMG_2047.HEIC`, 1.2–2.6 MB each. Every one stored with **no web
derivative** — the image pipeline produced nothing for them.

Two minutes later he deleted all seven, one at a time. Three minutes after that he uploaded the same
seven as JPEG. Those processed correctly, web derivatives and all.

So he photographed a site on his phone, found the pictures would not display, deleted them
individually, converted them somewhere else, and started again — **on the single most important thing
he does on site.** Then said nothing about it.

**Cause:** `sharp` handles HEIC only when built against `libheif`, which the deployed build is not.
The upload is accepted, the derivative step yields nothing, and the record ends up holding a file the
app cannot show.

**Two separate faults, and the second is worse than the first.** Not supporting HEIC is a limitation.
*Accepting the upload and then silently producing nothing* is a defect — it should either convert on
receipt or refuse the file and say why. A technician on a plant roof should not be diagnosing image
formats.

**Also worth carrying into the simplification:** the seven JPEGs total about 19 MB for one inspection.
Ten inspections a week is manageable; it will not stay that way, and site photographs are the one
thing this company will never agree to delete.

### A document number was consumed and no record made

The inquiry series reads `AIESINQ-260001, 260002, 260003, 260004, 260006`. Five inquiries, six
numbers. **`260005` was allocated and never became anything.**

Nothing in the audit log corresponds to it, so whatever failed happened between allocating the number
and writing the row — the number is drawn first, deliberately, so that two people cannot be handed
the same one.

A gap in a document series is the correct outcome and not itself a bug: module 00 §3 does not reuse a
number, and a gap is a true record that one was issued. What is *not* known is why the create failed,
because a failed create writes nothing. This is the standing gap below, showing up in the one place
it can be seen at all.

---

## Standing gap: refusals are invisible

The audit log records what **succeeded**. A gate refusing somebody, a validation message, a 403, a
screen opened and abandoned — none of it writes a row. Every entry above exists only because a person
remembered and typed it out.

For a week whose entire purpose is finding friction, the most valuable moments are the ones leaving
no trace. Recording refusals would be a small change. Raised 2026-08-25, not yet actioned.
