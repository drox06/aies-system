import { describe, expect, it } from "vitest";
import {
  answerKey,
  assessRequirements,
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
});
