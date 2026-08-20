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

export const collabManifest = defineManifest({
  key: "collab",
  name: "Collaboration",
  version: "0.1.0",
  models: ["Task"],

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
  ],

  emits: ["task.created", "task.assigned", "task.completed"],

  // §8's `task.overdue` belongs to the sweep that has not been written yet, and templates listen for
  // other modules' events from session 2. Both arrive with the code that raises them.
  consumes: [],

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
  ],
});
