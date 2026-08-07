import { describe, expect, it } from "vitest";
import {
  buildModuleRegistry,
  defineManifest,
  ModuleRegistryError,
  type ModuleManifest,
} from "@/server/core/module-registry";

function manifest(overrides: Partial<ModuleManifest> & { key: string }): ModuleManifest {
  return {
    name: overrides.key,
    version: "0.1.0",
    models: [],
    permissions: [],
    emits: [],
    consumes: [],
    ...overrides,
  };
}

describe("buildModuleRegistry", () => {
  it("assembles permissions and nav from all active modules, nav sorted by order", () => {
    const crm = manifest({
      key: "crm",
      permissions: [{ key: "crm.view", label: "View CRM", group: "CRM" }],
      nav: [{ label: "Accounts", href: "/accounts", order: 20 }],
    });
    const quotation = manifest({
      key: "quotation",
      permissions: [{ key: "quotation.approve", label: "Approve quotations", group: "Sales" }],
      nav: [{ label: "Quotations", href: "/quotations", order: 10 }],
    });

    const registry = buildModuleRegistry([crm, quotation]);

    expect(registry.modules).toHaveLength(2);
    expect(registry.permissions.map((p) => p.key)).toEqual(["crm.view", "quotation.approve"]);
    expect(registry.nav.map((n) => n.label)).toEqual(["Quotations", "Accounts"]);
  });

  it("throws on a permission key collision between two modules", () => {
    const a = manifest({ key: "a", permissions: [{ key: "shared.key", label: "A", group: "g" }] });
    const b = manifest({ key: "b", permissions: [{ key: "shared.key", label: "B", group: "g" }] });

    expect(() => buildModuleRegistry([a, b])).toThrow(ModuleRegistryError);
    try {
      buildModuleRegistry([a, b]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleRegistryError);
      expect((err as ModuleRegistryError).issues[0]).toContain("shared.key");
    }
  });

  it("throws on an event name collision between two modules", () => {
    const a = manifest({ key: "a", emits: ["thing.created"] });
    const b = manifest({ key: "b", emits: ["thing.created"] });

    expect(() => buildModuleRegistry([a, b])).toThrow(/Event "thing.created"/);
  });

  it("throws when a module consumes an event nobody emits", () => {
    const consumer = manifest({
      key: "consumer",
      consumes: [{ event: "ghost.event", handler: () => {} }],
    });

    expect(() => buildModuleRegistry([consumer])).toThrow(/unknown event "ghost.event"/);
  });

  it("excludes a disabled module's nav, permissions, and event subscribers", () => {
    const emitter = manifest({ key: "emitter", emits: ["thing.created"] });
    const consumer = manifest({
      key: "consumer",
      permissions: [{ key: "consumer.act", label: "Act", group: "g" }],
      nav: [{ label: "Consumer", href: "/consumer" }],
      consumes: [{ event: "thing.created", handler: () => {} }],
    });

    const registry = buildModuleRegistry([emitter, consumer], {
      disabledModuleKeys: ["consumer"],
    });

    expect(registry.modules.map((m) => m.key)).toEqual(["emitter"]);
    expect(registry.permissions).toHaveLength(0);
    expect(registry.nav).toHaveLength(0);
    expect(registry.eventSubscribers.get("thing.created")).toBeUndefined();
  });

  it("still validates a disabled module against collisions with active modules", () => {
    const active = manifest({ key: "active", permissions: [{ key: "x", label: "X", group: "g" }] });
    const disabled = manifest({
      key: "disabled",
      permissions: [{ key: "x", label: "X again", group: "g" }],
    });

    expect(() =>
      buildModuleRegistry([active, disabled], { disabledModuleKeys: ["disabled"] }),
    ).toThrow(ModuleRegistryError);
  });

  it("defineManifest is an identity helper", () => {
    const m = manifest({ key: "identity" });
    expect(defineManifest(m)).toBe(m);
  });
});
