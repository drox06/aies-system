import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetJobHandlersForTests,
  getJobHandler,
  registerJobHandler,
} from "@/server/core/jobs/registry";

afterEach(() => {
  __resetJobHandlersForTests();
});

describe("job handler registry", () => {
  it("registers and retrieves a handler by queue name", () => {
    const handler = vi.fn();
    registerJobHandler("emails", handler);
    expect(getJobHandler("emails")).toBe(handler);
  });

  it("returns undefined for an unregistered queue", () => {
    expect(getJobHandler("nope")).toBeUndefined();
  });

  it("throws when registering a second handler for the same queue", () => {
    registerJobHandler("emails", vi.fn());
    expect(() => registerJobHandler("emails", vi.fn())).toThrow(/already registered/);
  });
});
