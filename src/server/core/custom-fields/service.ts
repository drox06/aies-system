import { db } from "@/lib/db";

export interface UpsertCustomFieldDefInput {
  entityType: string;
  key: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
  order?: number;
}

export function listCustomFieldDefs(entityType: string) {
  return db.customFieldDef.findMany({
    where: { entityType, isActive: true },
    orderBy: { order: "asc" },
  });
}

export function upsertCustomFieldDef(input: UpsertCustomFieldDefInput) {
  const data = {
    label: input.label,
    type: input.type,
    options: input.options ?? undefined,
    required: input.required ?? false,
    order: input.order ?? 0,
    isActive: true,
  };

  return db.customFieldDef.upsert({
    where: { entityType_key: { entityType: input.entityType, key: input.key } },
    update: data,
    create: { entityType: input.entityType, key: input.key, ...data },
  });
}

/** Soft-disable rather than delete — existing stored values under this key are left alone. */
export function deactivateCustomFieldDef(entityType: string, key: string) {
  return db.customFieldDef.update({
    where: { entityType_key: { entityType, key } },
    data: { isActive: false },
  });
}
