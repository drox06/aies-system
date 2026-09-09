import { describe, expect, it } from "vitest";
import {
  answerKey,
  assessRequirements,
  groupSharedFields,
  sharedAnswerPatch,
  SEED_REQUIREMENT_TEMPLATES,
  type RequirementTemplateDef,
} from "@/server/core/crm/requirements";
import { SERVICE_TYPES } from "@/server/core/crm/inquiry-lifecycle";

/**
 * specs/01-crm-inquiry.md §4's completeness gate.
 *
 * §10 asks for one case by name: "Requirements gate blocks `quoting` transition until complete or
 * overridden with a reason." The transition itself is exercised in inquiry-flow.test.ts against the
 * real database; this file pins the scoring underneath it.
 */

const templates: RequirementTemplateDef[] = [
  {
    serviceType: "supply",
    label: "Supply",
    fields: [
      { key: "medium", label: "Process medium", type: "text", required: true },
      { key: "line_size", label: "Line size", type: "text", required: true },
      { key: "brand", label: "Preferred brand", type: "text", required: false },
    ],
  },
  {
    serviceType: "installation",
    label: "Installation",
    fields: [
      { key: "site_access", label: "Site access", type: "text", required: true },
      { key: "civil", label: "Civil works", type: "boolean", required: true },
    ],
  },
];

describe("assessRequirements", () => {
  it("only asks the questions the inquiry's line items call for", () => {
    const result = assessRequirements(templates, ["supply"], {});
    expect(result.applicableServiceTypes).toEqual(["supply"]);
    // Installation's two required fields are not counted against a supply-only inquiry.
    expect(result.requiredTotal).toBe(2);
  });

  it("names what is missing rather than only counting it", () => {
    // A bar reading "1 of 2" tells you that you are stuck without telling you what to go and ask.
    const result = assessRequirements(templates, ["supply"], {
      [answerKey("supply", "medium")]: "Potable water",
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.label).toBe("Line size");
  });

  it("is complete once every required field is answered, ignoring the optional ones", () => {
    const result = assessRequirements(templates, ["supply"], {
      [answerKey("supply", "medium")]: "Potable water",
      [answerKey("supply", "line_size")]: "DN100 Sch 40",
    });
    expect(result.complete).toBe(true);
    expect(result.requiredAnswered).toBe(2);
  });

  it("namespaces answers by service type so two templates cannot overwrite each other", () => {
    // Both templates would otherwise share a bare "site_access" key, and answering one would mark
    // the other answered.
    const both = assessRequirements(templates, ["supply", "installation"], {
      [answerKey("supply", "medium")]: "Steam",
      [answerKey("supply", "line_size")]: "DN50",
      [answerKey("installation", "site_access")]: "Gate pass 3 days ahead",
    });
    expect(both.requiredTotal).toBe(4);
    expect(both.missing.map((m) => m.key)).toEqual(["civil"]);
  });

  it("counts a deliberate `false` as an answer but an empty string as not", () => {
    // "No civil works" is an answer, and treating it as blank would block a complete inquiry.
    const answered = assessRequirements(templates, ["installation"], {
      [answerKey("installation", "site_access")]: "None",
      [answerKey("installation", "civil")]: false,
    });
    expect(answered.complete).toBe(true);

    const blank = assessRequirements(templates, ["installation"], {
      [answerKey("installation", "site_access")]: "   ",
      [answerKey("installation", "civil")]: false,
    });
    expect(blank.complete).toBe(false);
  });

  it("treats an inquiry with no service types as trivially complete", () => {
    // Deliberate: the gate exists to stop unanswered questions reaching a quotation, not to force
    // line items onto a single-line enquiry.
    const result = assessRequirements(templates, [], {});
    expect(result.complete).toBe(true);
    expect(result.applicableServiceTypes).toEqual([]);
  });
});

describe("the seeded templates", () => {
  it("covers every service type an inquiry line can carry", () => {
    // A line item with a service type nobody wrote a template for would pass the gate by asking
    // nothing at all — the silent failure §4 is guarding against.
    const covered = new Set(SEED_REQUIREMENT_TEMPLATES.map((t) => t.serviceType));
    for (const serviceType of SERVICE_TYPES) {
      expect(covered.has(serviceType), `no template for "${serviceType}"`).toBe(true);
    }
  });

  it("asks at least one blocking question per template", () => {
    for (const template of SEED_REQUIREMENT_TEMPLATES) {
      const required = template.fields.filter((f) => f.required);
      expect(required.length, `${template.serviceType} blocks on nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * "Others" is where the question was reached, not where it was answered.
   *
   * Two failures are possible here and they point in opposite directions, so both are named:
   * counting the specify box while it is hidden would block every ordinary enquiry on a question
   * nobody is being shown, and *not* counting it once "Others" is chosen would let an enquiry reach
   * quoting with its most important line reading "Others" — the exact round-trip §4 exists to stop.
   */
  describe("the conditional specify box", () => {
    const supplied = (category: string, other?: string) => ({
      "supply.equipment_category": category,
      ...(other === undefined ? {} : { "supply.equipment_category_other": other }),
    });

    it("is not asked, and not missed, when a real category is chosen", () => {
      const result = assessRequirements(SEED_REQUIREMENT_TEMPLATES, ["supply"], {
        ...supplied("Flow Instrument"),
      });
      expect(result.missing.map((m) => m.key)).not.toContain("equipment_category_other");
    });

    it("becomes required the moment Others is chosen", () => {
      const result = assessRequirements(SEED_REQUIREMENT_TEMPLATES, ["supply"], {
        ...supplied("Others — specify"),
      });
      expect(result.missing.map((m) => m.key)).toContain("equipment_category_other");
      expect(result.complete).toBe(false);
    });

    it("is satisfied once it is filled in", () => {
      const result = assessRequirements(SEED_REQUIREMENT_TEMPLATES, ["supply"], {
        ...supplied("Others — specify", "Ultrasonic clamp-on kit"),
      });
      expect(result.missing.map((m) => m.key)).not.toContain("equipment_category_other");
    });
  });

  it("gives every select field its options", () => {
    for (const template of SEED_REQUIREMENT_TEMPLATES) {
      for (const field of template.fields) {
        if (field.type !== "select") continue;
        expect(field.options?.length, `${template.serviceType}.${field.key}`).toBeGreaterThan(1);
      }
    }
  });

  it("uses unique field keys within a template", () => {
    for (const template of SEED_REQUIREMENT_TEMPLATES) {
      const keys = template.fields.map((f) => f.key);
      expect(new Set(keys).size, `${template.serviceType} has a duplicate key`).toBe(keys.length);
    }
  });

  /**
   * Guards the fix itself. A field shared across templates only reads as one question if every
   * copy asks it identically — a diverging label or help text is what makes `groupSharedFields`
   * pick an arbitrary winner and the other templates' wording silently vanish.
   */
  it("asks every shared key identically across every template that shares it", () => {
    const byKey = new Map<string, RequirementTemplateDef["fields"]>();
    for (const template of SEED_REQUIREMENT_TEMPLATES) {
      for (const field of template.fields) {
        byKey.set(field.key, [...(byKey.get(field.key) ?? []), field]);
      }
    }
    for (const [key, fields] of byKey) {
      if (fields.length < 2) continue;
      const first = fields[0]!;
      for (const field of fields.slice(1)) {
        expect(field.label, `${key}: label`).toBe(first.label);
        expect(field.type, `${key}: type`).toBe(first.type);
        expect(field.help, `${key}: help`).toBe(first.help);
      }
    }
  });
});

/**
 * docs/DECISIONS.md #195. `site_access`, `power_supply`, `hazardous_area`, `documentation_required`
 * and `equipment_scope` are each asked by more than one template about the same real-world fact —
 * a customer calling for supply and installation on one inquiry does not have two power supplies.
 * `equipment_tags` (installation's `existing_equipment_tags`, renamed to match corrective's) is the
 * same fix for a fact two templates used to name differently. Reported live, AIESSIR-260002.
 */
describe("groupSharedFields and sharedAnswerPatch", () => {
  it("groups a key that only one applicable template asks, on its own", () => {
    const groups = groupSharedFields(templates);
    const medium = groups.find((g) => g.key === "medium")!;
    expect(medium.serviceTypes).toEqual(["supply"]);
    expect(medium.required).toBe(true);
  });

  it("finds every real seed key that more than one template shares", () => {
    const groups = groupSharedFields(SEED_REQUIREMENT_TEMPLATES);
    const sharedKeys = new Set(groups.filter((g) => g.serviceTypes.length > 1).map((g) => g.key));
    expect(sharedKeys).toEqual(
      new Set([
        "site_access",
        "power_supply",
        "hazardous_area",
        "documentation_required",
        "equipment_scope",
        "equipment_tags",
      ]),
    );
  });

  it("is required if any applicable template requires it, even if others don't", () => {
    const groups = groupSharedFields(SEED_REQUIREMENT_TEMPLATES);
    // installation and inspection require site_access; calibration, pm and corrective don't.
    const siteAccess = groups.find((g) => g.key === "site_access")!;
    expect(siteAccess.required).toBe(true);
    expect(siteAccess.serviceTypes.sort()).toEqual(
      ["calibration", "corrective", "inspection", "installation", "pm"].sort(),
    );
  });

  it("writes one answer to every applicable template's namespaced slot", () => {
    const patch = sharedAnswerPatch(["installation", "inspection"], "site_access", "Escort only");
    expect(patch).toEqual({
      [answerKey("installation", "site_access")]: "Escort only",
      [answerKey("inspection", "site_access")]: "Escort only",
    });
  });

  it("answering a shared field once satisfies every applicable template's copy of it", () => {
    const mixed = SEED_REQUIREMENT_TEMPLATES.filter((t) =>
      ["installation", "calibration"].includes(t.serviceType),
    );
    const patch = sharedAnswerPatch(["installation", "calibration"], "site_access", "Escort req'd");
    const result = assessRequirements(mixed, ["installation", "calibration"], patch);
    expect(result.missing.some((m) => m.key === "site_access")).toBe(false);
  });
});
