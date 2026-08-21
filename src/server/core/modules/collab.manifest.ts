import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 06 — Collaboration Workspace (specs/06-collaboration.md).
 *
 * §1's problem, in the company's words: *"All work assignments are done thru meetings without proper
 * documentation."* Session 1 builds the record that replaces the meeting — §2's `Task`, attached to
 * the business record it serves, with an owner and a due date — plus My Work, the one screen §2 asks
 * to answer *"what am I supposed to be doing?"*.
 *
 * Boards, templates, channels, the calendar and notification preferences arrive in later sessions,
 * and their permissions arrive with them. §14 lists `task.manage_boards` and `channel.create`; both
 * are deliberately absent here, because a permission with nothing behind it sits in the role screen
 * granting access to nothing (docs/DECISIONS.md #52).
 */

/**
 * Everybody. Not an oversight — a task is how work reaches a person, and a role that cannot see
 * tasks cannot be given any. `viewer` is included for the same reason it can read a ticket: it is
 * the read-only account, and the tasks it can see are still only the ones addressed to it or hanging
 * off a record it can already open.
 */
const EVERYONE = [
  "president",
  "vice_president",
  "operations_manager",
  "admin_manager",
  "marketing_manager",
  "sales",
  "finance_officer",
  "technician",
  "viewer",
];

/** Everyone who does the company's work. `viewer` is read-only by definition, so it is not here. */
const EVERYONE_WHO_ACTS = EVERYONE.filter((role) => role !== "viewer");

/**
 * The events §2's templates listen for, in the same order the spec's table gives them.
 *
 * A literal list, kept in step with `task-trigger-resolvers.ts` by a test rather than by an import.
 */
const TRIGGER_EVENTS = [
  "sales_order.created",
  "ticket.generated",
  "cash_advance.requested",
  "cash_advance.released",
  "material_request.raised",
  "material.purchase_required",
  "methodology.approved",
  "scope_change.identified",
  "qa.failed",
  "tc.completed",
  "delivery.attempt_failed",
  "project.closed",
  "ticket.demobilized",
];

/**
 * The events §3's automatic channels listen for.
 *
 * Both are already in `TRIGGER_EVENTS` for a different reason — templates — and both are subscribed
 * twice on purpose rather than folded into one handler. A project channel opening and a task being
 * raised are unrelated consequences of the same fact, and one failing must not take the other with
 * it: the job runner calls each subscriber in turn.
 */
const CHANNEL_EVENTS = ["ticket.generated", "project.closed"];

export const collabManifest = defineManifest({
  key: "collab",
  name: "Collaboration",
  version: "0.1.0",
  models: [
    "Task",
    "TaskTemplate",
    "Board",
    "Channel",
    "ChannelMember",
    "Message",
    "CalendarEvent",
    "CalendarFeedToken",
    "Announcement",
    "AnnouncementAck",
    "Meeting",
  ],

  permissions: [
    {
      key: "task.view",
      label: "View tasks",
      group: "Collaboration",
      defaultRoles: EVERYONE,
    },
    {
      key: "task.create",
      label: "Raise a task",
      group: "Collaboration",
      // Wide on purpose. §1's failure is work assigned verbally and never written down; a platform
      // where only managers may write a task down would keep most of that work in the meeting.
      defaultRoles: EVERYONE_WHO_ACTS,
    },
    {
      key: "task.assign",
      label: "Give a task to somebody else",
      group: "Collaboration",
      /*
        Narrower than `task.create`, and the split is the point.

        Anybody may write down work — including work they are taking on themselves, which needs no
        grant beyond `task.create`. Putting work into *another person's* queue is a different act:
        it is what used to happen in the meeting, and it is the one that needs to be attributable to
        somebody who may make it.

        Technicians are included because a crew lead reassigns the day's work at site, which is
        exactly the assignment §1 says currently leaves no record.
      */
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "marketing_manager",
        "finance_officer",
        "technician",
      ],
    },
    {
      key: "task.manage_templates",
      label: "Turn task templates on and off, and change how they assign",
      group: "Collaboration",
      /*
        §2 asks for the assignment mode to be "configurable", and this is what makes it so.

        Narrow on purpose. A template is a standing instruction about who does what — switching one
        off stops work being raised across the whole company, and nobody would notice for a week.
        That is an owner's decision, not an everyday one.
      */
      defaultRoles: ["president", "vice_president", "operations_manager", "admin_manager"],
    },
    {
      key: "task.manage_boards",
      label: "Create and change boards",
      group: "Collaboration",
      /*
        §14 names this permission. Wider than the template grant, narrower than everybody: making a
        board is an ordinary act — a manager wants a board for their own jobs — but a board is also
        how a team agrees what it is looking at, and a hundred half-made boards is how that stops
        working. Working *from* a board needs nothing beyond `task.create`.
      */
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "marketing_manager",
        "finance_officer",
      ],
    },
    {
      key: "channel.create",
      label: "Open a channel",
      group: "Collaboration",
      /*
        Everybody who does the company's work.

        §1's problem is that things are said and not written down. A platform where most people
        cannot open a channel to say something in would push those conversations back to the phone,
        which is exactly where they are now. `viewer` is out: it is the read-only account.
      */
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "marketing_manager",
        "sales",
        "finance_officer",
        "technician",
      ],
    },
    {
      key: "channel.manage",
      label: "Rename, archive and manage the members of any channel",
      group: "Collaboration",
      // Acting on a channel that is not yours — including archiving one people are using.
      defaultRoles: ["president", "vice_president", "operations_manager", "admin_manager"],
    },
    {
      key: "message.delete_any",
      label: "Remove somebody else's message",
      group: "Collaboration",
      /*
        Narrow, and audited when used.

        A conversation people can have edited out from under them is not a record. This exists for
        the case that genuinely needs it — something posted that should never have been — and every
        use writes an audit row naming who did it.
      */
      defaultRoles: ["president", "vice_president", "admin_manager"],
    },
    {
      key: "announcement.publish",
      label: "Publish an announcement, and see who has not read it",
      group: "Collaboration",
      /*
        §5's announcements are ISO clause 7.4 evidence, and the compliance list is a list of
        colleagues who have not done something. Both belong with the people who own procedure: the
        officers and the two managers. Everybody else reads and acknowledges, which needs nothing.
      */
      defaultRoles: ["president", "vice_president", "operations_manager", "admin_manager"],
    },
  ],

  emits: [
    "task.created",
    "task.assigned",
    "task.completed",
    "message.mentioned",
    "announcement.published",
    "meeting.minutes_published",
  ],

  /**
   * §2's thirteen trigger events.
   *
   * Listed literally rather than mapped from `TRIGGER_EVENTS`, because importing the resolvers here
   * would pull Prisma into every module that reads the registry — the nav does, on every request.
   * `tests/server/core/collab/template-triggers.test.ts` asserts the two lists are identical, so
   * they cannot drift in silence: a resolver with no subscription would never fire, and a
   * subscription with no resolver would run on every event and do nothing.
   */
  consumes: [
    ...CHANNEL_EVENTS.map((event) => ({
      event,
      handler: async (payload: unknown) => {
        const { ensureProjectChannel, ensureTicketChannel, archiveProjectChannel } =
          await import("@/server/core/collab/channel-service");
        const data = (payload ?? {}) as Record<string, unknown>;

        if (event === "project.closed" && typeof data.projectId === "string") {
          // §3: the channel "archives read-only and is retained as part of the project record".
          await archiveProjectChannel(data.projectId);
          return;
        }

        if (event === "ticket.generated") {
          if (typeof data.projectId === "string") await ensureProjectChannel(data.projectId);
          // Tickets get their own channel only when they are high or emergency — §3 is explicit
          // that a channel per routine delivery turns the list into noise. The service checks.
          const tickets = Array.isArray(data.tickets) ? data.tickets : [];
          for (const ticket of tickets) {
            const id = (ticket as Record<string, unknown>).ticketId;
            if (typeof id === "string") await ensureTicketChannel(id);
          }
        }
      },
    })),
    ...TRIGGER_EVENTS.map((event) => ({
      event,
      handler: async (payload: unknown) => {
        /*
        Off during the test suite, and nowhere else.

        The suite creates real orders and tickets through the real services, which emit real events;
        when the queue drains, this subscriber raised 278 real tasks for real people against fixture
        records that had already been deleted. docs/DECISIONS.md #142. The check is here rather than
        in the service so that `runTemplatesForEvent` still behaves exactly as it does in production
        when a test calls it directly.
      */
        if (process.env.AIES_DISABLE_TASK_TEMPLATES === "1") return;

        const { runTemplatesForEvent } = await import("@/server/core/collab/task-template-service");
        await runTemplatesForEvent(event, (payload ?? {}) as Record<string, unknown>);
      },
    })),
  ],

  nav: [
    {
      label: "My Work",
      href: "/my-work",
      icon: "list-checks",
      permission: "task.view",
      /*
        Ungrouped and at the very top, above Approvals.

        Every other nav entry names a kind of record; this one names the person reading it. §2 asks
        for one screen that answers "what am I supposed to be doing?", and an answer filed under
        Operations or Collaboration is an answer somebody has to go looking for.
      */
      order: 0,
    },
    {
      label: "All tasks",
      href: "/tasks",
      icon: "list-checks",
      /*
        Behind `task.assign` rather than `task.view`.

        My Work answers "what do I owe". This one answers "what does everybody owe, and is anything
        sitting unassigned" — which is a question for whoever routes work, and the same grant that
        lets them do something about the answer.
      */
      permission: "task.assign",
      group: "Collaboration",
      order: 50,
    },
    {
      label: "Meetings",
      href: "/meetings",
      icon: "users",
      // Everybody: §6's point is that a meeting leaves a record, and a record only half the company
      // can read is half a record.
      group: "Collaboration",
      order: 55,
    },
    {
      label: "Calendar",
      href: "/calendar",
      icon: "calendar",
      // §4's cross-company view. No permission: the dates it shows come from records people can
      // already open, and the two finance sources are filtered inside the service.
      group: "Collaboration",
      order: 53,
    },
    {
      label: "Announcements",
      href: "/announcements",
      icon: "megaphone",
      // Everybody. An announcement nobody can find is a notice nobody read, and the acknowledgement
      // this screen collects is the whole point of §5.
      group: "Collaboration",
      order: 54,
    },
    {
      label: "Channels",
      href: "/channels",
      icon: "message-square",
      // Nothing narrower than "signed in". Reading a channel is not a privilege in a company of
      // nine; which channels somebody can see is decided by membership, not by a permission.
      group: "Collaboration",
      order: 52,
    },
    {
      label: "Boards",
      href: "/boards",
      icon: "columns",
      // §2's Trello replacement. `task.view`, not `task.manage_boards` — reading a board is how
      // most people will use one, and hiding the entry from them would leave the boards to the
      // handful of people who can make them.
      permission: "task.view",
      group: "Collaboration",
      order: 51,
    },
  ],
});
