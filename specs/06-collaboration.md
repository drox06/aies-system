# Module 06 — Collaboration Workspace

**Depends on:** 00. **Blocks:** nothing, but everything gets better with it.
**Definition of done:** the team can stop using the external chat app and the Trello board,
because discussion and work assignment now live next to the records they concern.

---

## 1. The actual problem being solved

> *"All communications and coordination are done on external apps. All work assignments are done
> thru meetings without proper documentation."*

Note what this is really saying: work is assigned in a way that produces no record. The fix is
not "build a chat app" — a chat app produces no record either. The fix is that **every
assignment is a task attached to a business record, with an owner and a due date**, and
discussion happens on that record.

So build tasks first and channels second. Channels exist to cover the residual conversation that
genuinely doesn't belong to any record; they must not become the place where work is assigned.

---

## 2. Tasks (the Trello replacement)

```prisma
model Task {
  id, number, title, description
  entityType?, entityId?          // the record this task serves — inquiry, quotation, SO, ticket, project, cash advance, material request, NCR
  boardId?, columnId?, position
  assigneeId?, watcherIds String[]
  status        // todo | in_progress | blocked | for_review | done | cancelled
  priority      // low | normal | high | urgent
  dueAt?, startAt?, completedAt?
  estimateHours?, actualHours?
  labels String[], checklist Json
  parentTaskId?, blockedByTaskIds String[]
  recurrenceRule?                 // for routine admin work
  createdById
}

model Board { id, name, type, ownerId, isPrivate, columns Json, wipLimits Json?, filterRule Json? }
model TaskTemplate { id, name, trigger, tasks Json }   // auto-create task sets on an event
```

Features:
- **Kanban and list views** per board, drag-and-drop, WIP limits, swimlanes by assignee or
  priority.
- **Smart boards**: a board can be defined by a filter rather than manual placement, e.g.
  "All tickets blocked at a gate" or "All quotations awaiting my approval". This is what makes
  the boards stay current without a human maintaining them.
- **Task templates fired by events.** This is the direct replacement for the meeting where work
  used to be assigned verbally. Seed templates mirroring the operations flowchart, since every
  box in it is someone's assignment:

  | Trigger event | Auto-created tasks |
  |---|---|
  | `sales_order.created` | Acknowledge PO to customer (sales, +1d) · Generate tickets (ops, +1d) · Raise supplier PO (procurement, +2d) · Raise downpayment invoice (finance, +1d) |
  | `ticket.generated` (new_project) | Schedule site inspection (ops, +3d) · Prepare methodology (ops lead, +5d) |
  | `ticket.generated` (delivery) | Request DR (ops, +1d) · Confirm site contact (ops, +1d) |
  | `cash_advance.requested` | Approve cash advance (ops lead/finance, before `neededBy`) · Release funds (finance) |
  | `cash_advance.released` | Liquidate advance (requester, +3d after demobilization) |
  | `material_request.raised` | Approve material request (ops lead, +1d) · Issue materials (stores, before mobilization) |
  | `material.purchase_required` | Raise purchase request (procurement, +1d) |
  | `methodology.approved` | Submit to client for approval (ops, +1d) — only when the account flag requires it |
  | `scope_change.identified` | Raise quotation revision (sales, +2d) |
  | `qa.failed` | Rectify defect (assignee per defect, per due date) · Re-inspect (QA) |
  | `tc.completed` | Close punch items (owners) · Prepare close-out pack (PM, +5d) |
  | `delivery.attempt_failed` | Contact customer and reschedule (ops, +1d) |
  | `project.closed` | Issue final invoice (finance, +2d) · Send satisfaction survey (sales, +3d) |
  | `ticket.demobilized` | Return tools and reconcile (crew lead, +1d) |

  Where a role has several holders, the template chooses assignment mode per template:
  round-robin, all, or least-loaded. Make this configurable and test all three.
- **My Work** view: everything assigned to me across every module, sorted by due date, with
  overdue highlighted. One screen answers "what am I supposed to be doing?"
- Task completion can be required before a parent record advances status (configurable per
  record type).

---

## 3. Channels and direct messages (the Slack replacement)

```prisma
model Channel  { id, name, description, type, isPrivate, entityType?, entityId?, memberIds String[], archivedAt? }
model Message  { id, channelId, authorId, body, threadRootId?, attachments, mentions String[], reactions Json, editedAt?, deletedAt? }
model ChannelMember { channelId, userId, lastReadAt, notificationLevel, joinedAt }
```

- Channel types: `team` (sales, operations, finance), `project` (auto-created and auto-archived
  with the project), `topic`, `direct`.
- Threading, @mentions, `@here`, emoji reactions, file attachments (routed through the module 07
  DMS, not loose blobs), markdown, code blocks, link previews for internal records.
- **Record linking:** typing `#QTN-2608-0042` renders an inline card with live status. Clicking
  goes to the record. This is the seam that makes chat useful rather than a parallel universe.
- **Promote to task:** any message → task, in one action, carrying the message as the
  description and linking back. This is how a casual "can someone check the Cebu delivery"
  becomes an accountable item instead of scrolling away.
- Search across messages, scoped by permission.
- Auto-created project channels include the project team; when the project closes, the channel
  archives read-only and is retained as part of the project record.
- **Ticket channels** are created for `high` and `emergency` tickets only — not for every routine
  delivery, or the channel list becomes noise. Routine coordination happens on the ticket's own
  activity feed.

**Explicit non-goals:** voice/video calling, external guest access, third-party app integrations,
custom emoji management. If the team needs a call, they will use a phone.

---

## 4. Shared calendar

- Unified calendar over: tickets (all four types), scheduled mobilizations and demobilizations,
  deliveries, PM visits, quotation validity expiries, invoice due dates, cash advance liquidation
  deadlines, calibration due dates, leave, and manual events.
- Views: month, week, my calendar, team calendar, dispatch calendar (module 04 owns the
  dispatch board; this is the read-only cross-company view).
- iCal feed per user (token-authenticated) so it can appear in their phone calendar.
- **No two-way Google Calendar sync in v1.** It is a large source of bugs and duplicate events.
  Read-only feed only.

---

## 5. Announcements and acknowledgement

- Company or department announcements with a **read-acknowledgement requirement** and a
  compliance list showing who has not acknowledged.
- Used for: policy changes, safety bulletins, revised procedures. This is ISO 9001 clause 7.4
  (communication) evidence, and it is trivially useful the first time a procedure changes.

---

## 6. Meetings

Since meetings will not disappear, make them produce records instead of replacing them.

- Meeting record: agenda, attendees, minutes, decisions, and **action items that are created as
  real tasks** with owners and due dates.
- Recurring meeting series carry forward open action items automatically.
- Management review meetings (ISO clause 9.3) use a fixed agenda template from module 08.

---

## 7. Notifications

Uses module 00's `notify` service. Per-user preferences with three levels per source: all,
mentions and assignments only, none. Daily digest at a configurable time. **Quiet hours by
default (18:00–07:00 Asia/Manila)** except for `urgent` priority and emergency tickets —
a system that pings technicians at midnight gets muted, and then the important message is missed
too.

---

## 8. Events

**Emits:** `task.created`, `task.assigned`, `task.completed`, `task.overdue`,
`message.mentioned`, `announcement.published`, `meeting.minutes_published`.

**Consumes:** every module's status events, to drive task templates and record-linked channels.

---

## 9. Permissions

`task.view` · `task.create` · `task.assign` · `task.manage_boards` · `channel.create` ·
`channel.manage` · `message.delete_any` · `announcement.publish` · `meeting.manage`

---

## 10. Tests

- Task template fires exactly once per triggering event and assigns to the correct role holders,
  including when a role has multiple holders (round-robin or all — make this configurable and
  test both).
- Promote-message-to-task preserves attachments and back-links.
- Channel permission scoping: a private channel is invisible in search to non-members.
- Quiet hours suppress non-urgent notifications and release them in the morning digest rather
  than dropping them.
