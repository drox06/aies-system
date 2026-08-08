import { describe, expect, it, vi } from "vitest";
import { createEventsHandler } from "@/server/core/jobs/handlers/events";
import type { EventJobPayload } from "@/server/core/jobs/relay";

describe("createEventsHandler", () => {
  it("dispatches to every subscriber registered for the event, with payload/event/attempt", async () => {
    const subscriberA = vi.fn();
    const subscriberB = vi.fn();
    const fakeRegistry = {
      eventSubscribers: new Map([
        [
          "user.created",
          [
            { event: "user.created", handler: subscriberA },
            { event: "user.created", handler: subscriberB },
          ],
        ],
      ]),
    };

    const handler = createEventsHandler(fakeRegistry);
    const payload: EventJobPayload = {
      outboxId: "o1",
      event: "user.created",
      payload: { userId: "u1" },
    };

    await handler(payload, { attempt: 2, jobId: "j1" });

    expect(subscriberA).toHaveBeenCalledWith(
      { userId: "u1" },
      { event: "user.created", attempt: 2 },
    );
    expect(subscriberB).toHaveBeenCalledWith(
      { userId: "u1" },
      { event: "user.created", attempt: 2 },
    );
  });

  it("is a no-op when nothing subscribed to the event", async () => {
    const handler = createEventsHandler({ eventSubscribers: new Map() });
    await expect(
      handler({ outboxId: "o1", event: "user.created", payload: {} } satisfies EventJobPayload, {
        attempt: 1,
        jobId: "j1",
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates a subscriber's error so the job queue retries it", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("subscriber blew up"));
    const handler = createEventsHandler({
      eventSubscribers: new Map([["user.created", [{ event: "user.created", handler: failing }]]]),
    });

    await expect(
      handler({ outboxId: "o1", event: "user.created", payload: {} } satisfies EventJobPayload, {
        attempt: 1,
        jobId: "j1",
      }),
    ).rejects.toThrow("subscriber blew up");
  });
});
