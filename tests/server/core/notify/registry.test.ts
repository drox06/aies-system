import { afterEach, describe, expect, it } from "vitest";
import {
  __resetNotificationTypesForTests,
  getNotificationType,
  listNotificationTypes,
  registerNotificationType,
} from "@/server/core/notify/registry";

afterEach(() => {
  __resetNotificationTypesForTests();
});

describe("notification type registry", () => {
  it("registers and retrieves a type", () => {
    registerNotificationType({
      key: "test.thing_happened",
      label: "Test thing happened",
      defaultChannels: { inApp: true, email: false, digest: false },
    });

    expect(getNotificationType("test.thing_happened")?.label).toBe("Test thing happened");
    expect(listNotificationTypes()).toHaveLength(1);
  });

  it("throws when registering a duplicate key", () => {
    registerNotificationType({
      key: "test.dup",
      label: "Dup",
      defaultChannels: { inApp: true, email: false, digest: false },
    });
    expect(() =>
      registerNotificationType({
        key: "test.dup",
        label: "Dup 2",
        defaultChannels: { inApp: true, email: false, digest: false },
      }),
    ).toThrow(/already registered/);
  });
});
