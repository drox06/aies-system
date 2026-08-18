# Build Protocol

How to work through this spec pack across many sessions without losing your place.

**The rule this whole document exists to enforce: the repository is the memory, not the
conversation.** Any session must be able to start cold, read three files, and know exactly where
the build is. If that is true, hitting a usage limit costs you nothing but time.

---

## 1. Claude Code maintains `PROGRESS.md`

Create `docs/PROGRESS.md` at the start of the build. Claude Code updates it **before** the end of
every working chunk — not at the end of a module, and never only when asked.

```markdown
# Build Progress

Last updated: <date/time>
Current module: 00 — Foundation
Status: in progress

## Done
- [x] Project bootstrap, TypeScript strict, ESLint, Husky
- [x] Prisma split schema + first migration
- [x] Module manifest system (src/server/core/module-registry.ts)
- [x] Auth.js with credentials + mandatory TOTP

## In progress
- [ ] RBAC — roles and permissions seeded; record-level scoping NOT started
      Next concrete step: implement scopeFor() in src/server/core/rbac/scope.ts

## Not started (this module)
- [ ] Audit log
- [ ] Event outbox + job queue
- [ ] Storage service
- [ ] Design system / brand extraction
- [ ] Deployment artifacts

## Decisions made this module
- See docs/DECISIONS.md entries #1–#4

## Known issues / to revisit
- Seed data for permissions is hand-written; consider generating from manifests
```

The "In progress" section carries a **next concrete step**, phrased as an instruction. That single
line is what lets a fresh session start work in its first message instead of spending a third of
a window re-orienting.

---

## 2. Commit after every chunk

```bash
git add -A
git commit -m "module 00: RBAC roles and permissions"
```

Not once per module — once per chunk of maybe 30–60 minutes of work. Two reasons: `git log`
becomes a second, tamper-proof progress record, and when something goes wrong you lose one chunk
rather than one module.

Tag the end of each module:

```bash
git tag module-00-complete
```

---

## 3. Start each session the same way

Paste this at the top of every new session:

```
Read docs/PROGRESS.md, then run `git log --oneline -15`.
Then read Spec.md and the spec file for the current module.

Continue from the "next concrete step" in PROGRESS.md.
Do not re-do completed work. Do not start a different module.

Update PROGRESS.md before you finish, and commit as you go.
```

This costs a few thousand tokens and replaces re-reading a 100,000-token conversation. On Pro,
that difference is most of your window.

---

## 4. When you hit a usage limit

1. **Do nothing destructive.** The session is saved on disk. Your files are on disk. Nothing is
   lost.
2. If Claude Code was mid-task, note what it was doing.
3. When the window resets, **prefer a fresh session over resuming**, using the §3 opener. It
   starts with a small context and gets straight to work.
4. Resume the old session only if you need something from the conversation that never made it
   into a file — and if you do, **choose "Resume from summary"** in the dialog, never
   "Resume full session as-is".

If a limit interrupts work mid-file and PROGRESS.md is stale, recover by reading `git status` and
`git diff` — the working tree tells you what was in flight.

---

## 5. Keep sessions short on purpose

- `/context` shows what is consuming the context window. Check it occasionally.
- `/compact` at roughly 50% usage, or after a run of failed attempts that can be summarised away.
  It is designed to be used often.
- `/clear` and re-open with the §3 prompt when switching to a different part of a module.
- `/rename module-00-rbac` so sessions are findable later.

A session that ends at 60% context having committed its work is a better outcome than one that
runs to 100% and gets truncated mid-thought.

---

## 6. Split the large modules

Two modules are too big for one Pro window. Break them at these seams and treat each as its own
session, committing between:

**Module 00 — Foundation** (5 sessions)
1. Bootstrap, Prisma, CI, module manifest system
2. Auth + TOTP + RBAC + seeded roles + approval fallback
3. Audit log, event outbox, job queue, numbering
4. Storage, notify, approvals, customFields, comments, search
5. Design system (brand extraction first), app shell, DataTable, deployment artifacts

**Module 04 — Operations** (4 sessions)
1. Tickets, generation, routing, cash advance gate
2. Site inspection, methodology, material request gate, mobilization
3. Execution, QA gate, T&C, warranty gate, service report, close-out
4. Delivery lane (both modes) and the offline PWA

The other modules should each fit in one or two sessions.

---

## 7. Review gates — do not skip these

After each module, before starting the next:

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] Migration applies cleanly to a fresh database
- [ ] Claude has **seeded realistic records** onto the module's screens
- [ ] Claude has **written the review steps** — open X, expect Y, wrong if Z
- [ ] The company has **walked those steps on a real screen**, desktop and phone
- [ ] Every defect the pass found is fixed, or recorded in `PROGRESS.md` as deliberately deferred
- [ ] `PROGRESS.md` and `DECISIONS.md` are current
- [ ] Committed **and only then** tagged

The manual check matters most. Tests pass on code that implements the wrong thing. Module 00's
check is: log in, create a user, assign a role, confirm the audit log caught all three, and
confirm a non-privileged role genuinely cannot see cost fields in the API response.

### 7.1 Why the pass is a gate and not a nicety

Through module 04, the score stood at:

| Round | Found by the company's pass | Found by the test suite |
| --- | --- | --- |
| Module 01 gate | 3 | 0 |
| Module 02 gate | 1 | 0 |
| Navigation pass | 8 | 0 |
| Phone pass | 3 | 0 |
| Module 04 gate | 6 | 0 |
| **Total** | **21** | **0** |

Twenty-one defects, none of them caught by more than 1,400 automated tests — and not because the
tests are weak. They catch logic and they have caught real things. Every one of these lived
somewhere tests do not look: a query key that changed between renders so a screen loaded forever
(#99), a finished screen with no menu entry (#94), a question with no control to answer it (#101),
two panels with confusable names, a permission nobody seeded so the feature 403'd for everybody.

Read the pattern before reading the rules: **the suite checks whether the code is right; the pass
checks whether a person can get to it and finish.** Those are different questions and only the
second one has a human in it.

### 7.2 The three rules

**1. The pass happens before the tag, never after.** A tag is a claim that the module is done, and a
module with six unfound screen defects is not done. Once a tag exists, everything after it reads as
a regression against a working baseline that was never working — which makes the history lie about
where the fault entered.

**2. The pass needs data on the screens.** Half of what module 04's pass found was only visible
because there was something to look at; an empty board tells nobody anything. Seeding realistic
records is part of preparing a gate, not an afterthought. Sample data is written by a script with
its own `--remove`, guarded behind `ALLOW_DEMO_DATA=1` and prefixed so it can never be mistaken for
real work (`scripts/sample-records-dispatch.ts` is the pattern) — and it comes back out before the
tag.

**3. Claude writes the review steps, including what should happen.** Not "have a look at dispatch"
but *open the dispatch board, expect the week grid within about three seconds, it is wrong if it
sits on "Loading the week"*. The company found that exact hang in seconds because the step said
what correct looked like. A reviewer who has to infer the intended behaviour is doing Claude's job
and will miss things Claude already knows.

### 7.3 What the pass cannot be delegated to

Claude may not sign its own gate. Playwright covering every screen is worth having and does not
substitute: it proved all 30-odd screens rendered on the same afternoon `/field` was unreachable
from the navigation, because it navigates by URL and a person navigates by looking. Where a check
*can* be made mechanical, make it a standing test instead of a step in the list — that is what
`tests/server/core/modules/every-screen-has-a-door.test.ts` and `permissions-are-seeded.test.ts`
are, each one a defect from a pass turned into something that cannot recur silently. **A defect
found by a human pass twice is a missing test, not bad luck.**

---

## 8. A note on plan sizing

This pack is roughly 200KB of specification across 11 modules. On Pro you will hit the 5-hour
window regularly — the protocol above makes that an interruption rather than a setback, but it is
still an interruption. If the build stalls badly at Phase 2, Max is worth costing against the
hours lost. Either way, do not let a limit push you into skipping §7.
