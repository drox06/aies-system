import { z } from "zod";
import { CUSTOM_FIELD_TYPES } from "@/server/core/custom-fields/schema";
import {
  deactivateCustomFieldDef,
  listCustomFieldDefs,
  upsertCustomFieldDef,
} from "@/server/core/custom-fields/service";
import { p, router } from "@/server/api/trpc";

export const customFieldsRouter = router({
  listDefs: p("admin.manage_custom_fields")
    .input(z.object({ entityType: z.string() }))
    .query(({ input }) => listCustomFieldDefs(input.entityType)),

  upsertDef: p("admin.manage_custom_fields")
    .input(
      z.object({
        entityType: z.string().min(1),
        key: z
          .string()
          .min(1)
          .regex(/^[a-z][a-z0-9_]*$/, "key must be lower_snake_case"),
        label: z.string().min(1),
        type: z.enum(CUSTOM_FIELD_TYPES),
        options: z.array(z.string()).optional(),
        required: z.boolean().optional(),
        order: z.number().int().optional(),
      }),
    )
    .mutation(({ input }) => upsertCustomFieldDef(input)),

  deactivateDef: p("admin.manage_custom_fields")
    .input(z.object({ entityType: z.string(), key: z.string() }))
    .mutation(({ input }) => deactivateCustomFieldDef(input.entityType, input.key)),
});
