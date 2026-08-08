import { registry as defaultRegistry } from "@/server/core/manifests";
import type { ModuleRegistry } from "@/server/core/module-registry";
import { registerJobHandler, type JobHandler } from "@/server/core/jobs/registry";
import type { EventJobPayload } from "@/server/core/jobs/relay";

/**
 * Dispatches a relayed EventOutbox row to every module that subscribed to that event name via
 * its manifest (specs/00-foundation.md §6: "Handlers are idempotent and receive
 * { payload, event, attempt }"). Takes the registry as a parameter (defaulting to the real
 * singleton) so this is testable with a fake registry, independent of whatever modules are
 * actually registered at the time the test runs.
 */
export function createEventsHandler(
  reg: Pick<ModuleRegistry, "eventSubscribers"> = defaultRegistry,
): JobHandler {
  return async (rawPayload, meta) => {
    const { event, payload } = rawPayload as EventJobPayload;
    const subscribers = reg.eventSubscribers.get(event) ?? [];

    for (const subscriber of subscribers) {
      await subscriber.handler(payload, { event, attempt: meta.attempt });
    }
  };
}

// Side-effect: importing this module registers the "events" queue handler.
registerJobHandler("events", createEventsHandler());
