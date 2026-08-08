import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deactivateCustomFieldDef,
  listCustomFieldDefs,
  upsertCustomFieldDef,
} from "@/server/core/custom-fields/service";

const entityType = `test_entity_${randomUUID().replace(/-/g, "")}`;

afterEach(async () => {
  await db.customFieldDef.deleteMany({ where: { entityType } });
});

describe("custom field def service", () => {
  it("upsertCustomFieldDef creates, then updates in place on a second call", async () => {
    await upsertCustomFieldDef({
      entityType,
      key: "flow_rate",
      label: "Flow Rate",
      type: "number",
    });
    const created = await db.customFieldDef.findUniqueOrThrow({
      where: { entityType_key: { entityType, key: "flow_rate" } },
    });
    expect(created.label).toBe("Flow Rate");

    await upsertCustomFieldDef({
      entityType,
      key: "flow_rate",
      label: "Flow Rate (LPM)",
      type: "number",
      required: true,
    });

    const rows = await db.customFieldDef.findMany({ where: { entityType } });
    expect(rows).toHaveLength(1); // still one row, not a duplicate
    expect(rows[0]?.label).toBe("Flow Rate (LPM)");
    expect(rows[0]?.required).toBe(true);
  }, 30_000);

  it("listCustomFieldDefs returns only active fields, ordered", async () => {
    await upsertCustomFieldDef({ entityType, key: "b_field", label: "B", type: "text", order: 2 });
    await upsertCustomFieldDef({ entityType, key: "a_field", label: "A", type: "text", order: 1 });
    await upsertCustomFieldDef({ entityType, key: "c_field", label: "C", type: "text", order: 3 });
    await deactivateCustomFieldDef(entityType, "c_field");

    const defs = await listCustomFieldDefs(entityType);
    expect(defs.map((d) => d.key)).toEqual(["a_field", "b_field"]);
  }, 30_000);
});
