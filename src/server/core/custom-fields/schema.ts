import type { CustomFieldDef } from "@prisma/client";
import { z } from "zod";

// specs/00-foundation.md §7.5's fixed type list.
export const CUSTOM_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "currency",
  "date",
  "select",
  "multiselect",
  "boolean",
  "user",
  "file",
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

function optionsOf(def: CustomFieldDef): string[] {
  return Array.isArray(def.options) ? (def.options as unknown[]).map(String) : [];
}

function baseZodType(def: CustomFieldDef): z.ZodTypeAny {
  switch (def.type as CustomFieldType) {
    case "text":
    case "textarea":
      return z.string();
    case "number":
    case "currency":
      return z.number();
    case "date":
      return z.coerce.date();
    case "boolean":
      return z.boolean();
    // Stored as the referenced record's id; the referenced entity's own service is responsible
    // for validating that id actually exists — this schema only checks shape.
    case "user":
    case "file":
      return z.string();
    case "select": {
      const options = optionsOf(def);
      return options.length > 0 ? z.enum(options as [string, ...string[]]) : z.string();
    }
    case "multiselect": {
      const options = optionsOf(def);
      return z.array(options.length > 0 ? z.enum(options as [string, ...string[]]) : z.string());
    }
    default:
      throw new Error(`Unknown custom field type "${def.type}" on field "${def.key}".`);
  }
}

/** Builds a Zod schema from a set of definitions — unknown keys are rejected (`.strict()`),
 *  since a `customFields` JSON column holds nothing but defined custom field values. */
export function buildCustomFieldsSchema(defs: readonly CustomFieldDef[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const def of defs) {
    if (!def.isActive) continue;
    const fieldSchema = baseZodType(def);
    shape[def.key] = def.required ? fieldSchema : fieldSchema.nullable().optional();
  }

  return z.object(shape).strict();
}

export function validateCustomFieldValues(
  defs: readonly CustomFieldDef[],
  values: unknown,
): Record<string, unknown> {
  return buildCustomFieldsSchema(defs).parse(values) as Record<string, unknown>;
}
