import { describe, expect, it } from "vitest";
import { collabManifest } from "@/server/core/modules/collab.manifest";
import { crmManifest } from "@/server/core/modules/crm.manifest";
import { financeManifest } from "@/server/core/modules/finance.manifest";
import { foundationManifest } from "@/server/core/modules/foundation.manifest";
import { operationsManifest } from "@/server/core/modules/operations.manifest";
import { orderManifest } from "@/server/core/modules/order.manifest";
import { quotationManifest } from "@/server/core/modules/quotation.manifest";
import { TRIGGER_EVENTS } from "@/server/core/collab/task-trigger-resolvers";
import { TASK_TEMPLATE_SEEDS } from "@/server/core/collab/task-template-seeds";

/**
 * The three ways §2's templates could be wired up and silently do nothing.
 *
 * Each of these is a failure with no symptom. A template that never fires produces no error, no log
 * line and no task — it produces *the situation the module was built to end*, which is work that
 * exists only in somebody's memory. Nothing else in the suite would notice.
 */

const MANIFESTS = [
  foundationManifest,
  crmManifest,
  quotationManifest,
  financeManifest,
  orderManifest,
  operationsManifest,
  collabManifest,
];

describe("the trigger wiring", () => {
  it("subscribes to exactly the events it can resolve, plus the two the channels need", () => {
    /*
      The manifest lists the events literally rather than importing them, because importing the
      resolvers would pull Prisma into every module that reads the registry — and the nav reads it
      on every request. This is what stops the two lists drifting.

      A subscription with no resolver runs on every occurrence of that event and does nothing. A
      resolver with no subscription is never called at all.

      `ticket.generated` and `project.closed` appear **twice** on purpose: once to raise §2's tasks
      and once to open or archive §3's channels. Two unrelated consequences of one fact, kept as two
      subscribers so that one failing does not take the other with it.
    */
    const subscribed = collabManifest.consumes.map((subscription) => subscription.event).sort();
    const expected = [...TRIGGER_EVENTS, "ticket.generated", "project.closed"].sort();
    expect(subscribed).toEqual(expected);
  });

  it("subscribes to the channel events exactly twice each", () => {
    // If one of the pair were dropped in a refactor, either the tasks or the channel would stop
    // happening — and the other would keep working, which is exactly how it would go unnoticed.
    for (const event of ["ticket.generated", "project.closed"]) {
      const count = collabManifest.consumes.filter(
        (subscription) => subscription.event === event,
      ).length;
      expect(count, event).toBe(2);
    }
  });

  it("only listens for events some module actually emits", () => {
    // A trigger nobody fires is a template that will never run. Spelling is enough to cause it:
    // "cash_advance.release" and "cash_advance.released" look identical at a glance.
    const emitted = new Set(MANIFESTS.flatMap((manifest) => manifest.emits));
    for (const event of TRIGGER_EVENTS) {
      expect(emitted.has(event), `nothing emits "${event}"`).toBe(true);
    }
  });

  it("has a resolver for every trigger the seeded templates use", () => {
    // The third way round: a template whose trigger nothing resolves is stored, listed on the
    // templates screen as active, and never raises anything.
    const resolvable = new Set(TRIGGER_EVENTS);
    for (const template of TASK_TEMPLATE_SEEDS) {
      expect(resolvable.has(template.trigger), `${template.key} → ${template.trigger}`).toBe(true);
    }
  });

  it("covers every row of §2's trigger table", () => {
    // Thirteen events, fourteen templates — `ticket.generated` carries two rows, split by the
    // ticket's type.
    expect(TRIGGER_EVENTS).toHaveLength(13);
    expect(TASK_TEMPLATE_SEEDS).toHaveLength(14);
  });
});
