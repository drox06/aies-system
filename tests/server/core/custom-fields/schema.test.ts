import { describe, expect, it } from "vitest";
import type { CustomFieldDef } from "@prisma/client";
import {
  buildCustomFieldsSchema,
  validateCustomFieldValues,
} from "@/server/core/custom-fields/schema";

function def(overrides: Partial<CustomFieldDef> & { key: string; type: string }): CustomFieldDef {
  return {
    id: `def_${overrides.key}`,
    entityType: "account",
    label: overrides.key,
    options: null,
    required: false,
    order: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CustomFieldDef;
}

describe("buildCustomFieldsSchema / validateCustomFieldValues", () => {
  it("validates text, number, boolean, and date fields", () => {
    const defs = [
      def({ key: "notes", type: "text" }),
      def({ key: "capacity", type: "number" }),
      def({ key: "is_active", type: "boolean" }),
      def({ key: "installed_on", type: "date" }),
    ];

    const result = validateCustomFieldValues(defs, {
      notes: "hello",
      capacity: 42,
      is_active: true,
      installed_on: "2026-08-08",
    });

    expect(result.notes).toBe("hello");
    expect(result.capacity).toBe(42);
    expect(result.is_active).toBe(true);
    expect(result.installed_on).toBeInstanceOf(Date);
  });

  it("restricts select/multiselect to the configured options", () => {
    const defs = [def({ key: "tier", type: "select", options: ["gold", "silver", "bronze"] })];

    expect(validateCustomFieldValues(defs, { tier: "gold" })).toEqual({ tier: "gold" });
    expect(() => validateCustomFieldValues(defs, { tier: "platinum" })).toThrow();
  });

  it("makes a field optional unless required is true", () => {
    const defs = [def({ key: "nickname", type: "text", required: false })];
    expect(validateCustomFieldValues(defs, {})).toEqual({});

    const requiredDefs = [def({ key: "nickname", type: "text", required: true })];
    expect(() => validateCustomFieldValues(requiredDefs, {})).toThrow();
  });

  it("rejects a key not present in any active definition (.strict())", () => {
    const defs = [def({ key: "notes", type: "text" })];
    expect(() => validateCustomFieldValues(defs, { notes: "ok", extra: "nope" })).toThrow();
  });

  it("excludes inactive definitions from the schema entirely", () => {
    const defs = [def({ key: "retired_field", type: "text", isActive: false })];
    const schema = buildCustomFieldsSchema(defs);
    expect(() => schema.parse({ retired_field: "x" })).toThrow();
    expect(schema.parse({})).toEqual({});
  });
});
