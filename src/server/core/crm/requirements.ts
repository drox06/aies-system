import type { ServiceType } from "@/server/core/crm/inquiry-lifecycle";

/**
 * Requirements capture and the completeness gate (specs/01-crm-inquiry.md §4).
 *
 * §4 opens with the point of the whole thing: "The single most valuable thing this module does is
 * stop the 'what exactly did they ask for?' round-trip that currently happens over chat." So these
 * are not decorative form fields — each one is a question somebody currently has to go back and ask,
 * usually a day later, usually after the customer has already been quoted by someone faster.
 *
 * Pure rules, no Prisma, so the form can score itself as it is filled in.
 */

export type RequirementFieldType = "text" | "number" | "select" | "boolean";

export interface RequirementField {
  key: string;
  label: string;
  type: RequirementFieldType;
  required: boolean;
  help?: string;
  options?: string[];
}

export interface RequirementTemplateDef {
  serviceType: ServiceType;
  label: string;
  fields: RequirementField[];
}

/**
 * Answers are stored under `"{serviceType}.{fieldKey}"`.
 *
 * Namespaced because an inquiry can carry several service types at once — §1's "the same account
 * may run several unrelated inquiries at once through different engineers" applies within one
 * inquiry too, and a supply line plus an installation line both want to know the line size. Without
 * the prefix the second template's answer would silently overwrite the first's.
 */
export function answerKey(serviceType: string, fieldKey: string): string {
  return `${serviceType}.${fieldKey}`;
}

/**
 * §4: "Seed templates for: instrumentation supply, valve supply, installation & commissioning,
 * calibration, preventive maintenance, corrective maintenance/troubleshooting, site inspection."
 *
 * Seven named templates, seven `serviceType` values — but not one-to-one. Instrumentation supply
 * and valve supply are both `supply`, so that template asks what distinguishes them; installation &
 * commissioning is named once but is two service types, because AIES is routinely engaged for one
 * without the other and a single template would ask commissioning questions of an install-only job.
 *
 * `required: true` is what blocks the move to `quoting`, so it is spent carefully: a field is
 * required only when a quotation genuinely cannot be priced without it. Everything else is asked
 * but not enforced, because a gate that blocks on nice-to-haves gets overridden every time and
 * stops meaning anything.
 */
export const SEED_REQUIREMENT_TEMPLATES: RequirementTemplateDef[] = [
  {
    serviceType: "supply",
    label: "Instrumentation / valve supply",
    fields: [
      {
        key: "equipment_category",
        label: "What is being supplied",
        type: "select",
        required: true,
        options: [
          "Flow meter",
          "Pressure transmitter",
          "Temperature transmitter",
          "Level instrument",
          "Analytical instrument",
          "Control valve",
          "Isolation valve",
          "Safety relief valve",
          "Other",
        ],
      },
      {
        key: "process_medium",
        label: "Process medium",
        type: "text",
        required: true,
        help: "Water, steam, chemical, gas — and its concentration if that matters.",
      },
      {
        key: "process_conditions",
        label: "Process conditions",
        type: "text",
        required: true,
        help: "Operating and design pressure, temperature, and flow range.",
      },
      {
        key: "line_size",
        label: "Line size",
        type: "text",
        required: true,
        help: "Nominal bore and schedule.",
      },
      {
        key: "connection_type",
        label: "Connection type",
        type: "text",
        required: true,
        help: "Flanged (rating and face), threaded, wafer, welded.",
      },
      {
        key: "material_of_construction",
        label: "Material of construction",
        type: "text",
        required: false,
        help: "Body and wetted parts, if the customer has specified them.",
      },
      {
        key: "power_supply",
        label: "Power supply / signal",
        type: "text",
        required: false,
        help: "24 VDC, 230 VAC, 4-20 mA, HART, Modbus.",
      },
      {
        key: "hazardous_area",
        label: "Hazardous area classification",
        type: "text",
        required: false,
        help: "Zone and gas group, or 'safe area'. Wrong here means the wrong certification.",
      },
      {
        key: "preferred_brand",
        label: "Preferred brand or equivalent",
        type: "text",
        required: false,
      },
      {
        key: "documentation_required",
        label: "Required documentation",
        type: "text",
        required: false,
        help: "Calibration certificate, material certs, test reports, O&M manual.",
      },
    ],
  },
  {
    serviceType: "installation",
    label: "Installation",
    fields: [
      {
        key: "scope_summary",
        label: "Scope of installation",
        type: "text",
        required: true,
        help: "What AIES installs, and explicitly what the customer supplies.",
      },
      {
        key: "existing_equipment_tags",
        label: "Existing equipment tag numbers",
        type: "text",
        required: true,
        help: "The tags being replaced or tied into. Without these the site visit is a guess.",
      },
      {
        key: "quantity_points",
        label: "Number of installation points",
        type: "number",
        required: true,
      },
      {
        key: "site_access",
        label: "Site access constraints",
        type: "text",
        required: true,
        help: "Gate pass lead time, induction, PPE, permitted working hours, escort required.",
      },
      {
        key: "shutdown_window",
        label: "Shutdown / tie-in window",
        type: "text",
        required: false,
        help: "Whether the line can be taken down, and when.",
      },
      {
        key: "civil_works",
        label: "Civil or structural work included",
        type: "boolean",
        required: false,
      },
      {
        key: "power_supply",
        label: "Power supply available at site",
        type: "text",
        required: false,
      },
      {
        key: "hazardous_area",
        label: "Hazardous area classification",
        type: "text",
        required: false,
      },
    ],
  },
  {
    serviceType: "commissioning",
    label: "Commissioning",
    fields: [
      {
        key: "equipment_scope",
        label: "Equipment to be commissioned",
        type: "text",
        required: true,
      },
      {
        key: "acceptance_criteria",
        label: "Acceptance criteria",
        type: "text",
        required: true,
        help: "What the customer will sign off against. Agreeing this after the fact is a dispute.",
      },
      {
        key: "witnessed_by_client",
        label: "Client witnessing required",
        type: "boolean",
        required: true,
      },
      {
        key: "integration_scope",
        label: "Control system integration",
        type: "text",
        required: false,
        help: "DCS/PLC/SCADA involved, and who owns the configuration.",
      },
      {
        key: "training_required",
        label: "Operator training required",
        type: "boolean",
        required: false,
      },
      {
        key: "documentation_required",
        label: "Required documentation",
        type: "text",
        required: false,
        help: "Commissioning report, loop test sheets, as-built drawings.",
      },
    ],
  },
  {
    serviceType: "calibration",
    label: "Calibration",
    fields: [
      {
        key: "instrument_list",
        label: "Instruments and tag numbers",
        type: "text",
        required: true,
        help: "Type, range and quantity. This drives both price and the laboratory booking.",
      },
      {
        key: "calibration_range",
        label: "Required calibration range and points",
        type: "text",
        required: true,
      },
      {
        key: "traceability_required",
        label: "Traceability required",
        type: "select",
        required: true,
        // Spec.md §11.1 item 5: calibration is outsourced to an accredited ISO/IEC 17025
        // laboratory, so which standard the certificate must carry is a purchasing decision, not a
        // detail.
        options: ["ISO/IEC 17025 accredited", "Traceable to national standard", "Not specified"],
      },
      {
        key: "location",
        label: "On-site or laboratory",
        type: "select",
        required: true,
        options: ["On-site", "Laboratory (pick-up and return)", "Customer delivers"],
      },
      {
        key: "downtime_constraints",
        label: "Downtime constraints",
        type: "text",
        required: false,
        help: "Whether instruments can be removed, and for how long.",
      },
      {
        key: "site_access",
        label: "Site access constraints",
        type: "text",
        required: false,
      },
    ],
  },
  {
    serviceType: "pm",
    label: "Preventive maintenance",
    fields: [
      {
        key: "equipment_scope",
        label: "Equipment covered",
        type: "text",
        required: true,
        help: "Tag numbers and quantities.",
      },
      {
        key: "frequency",
        label: "Service frequency",
        type: "select",
        required: true,
        options: ["Monthly", "Quarterly", "Semi-annual", "Annual", "Other"],
      },
      {
        key: "contract_duration",
        label: "Contract duration",
        type: "text",
        required: true,
        help: "How long the customer wants the coverage to run. This is what is being priced.",
      },
      {
        key: "response_time",
        label: "Required response time",
        type: "text",
        required: false,
      },
      {
        key: "spares_included",
        label: "Spares and consumables included",
        type: "boolean",
        required: false,
      },
      {
        key: "site_access",
        label: "Site access constraints",
        type: "text",
        required: false,
      },
    ],
  },
  {
    serviceType: "corrective",
    label: "Corrective maintenance / troubleshooting",
    fields: [
      {
        key: "fault_description",
        label: "Fault description",
        type: "text",
        required: true,
        help: "What the customer observes, in their words.",
      },
      {
        key: "equipment_tags",
        label: "Equipment tag numbers",
        type: "text",
        required: true,
      },
      {
        key: "when_started",
        label: "When the fault started",
        type: "text",
        required: true,
        help: "And whether it is intermittent — that changes how long the visit takes.",
      },
      {
        key: "production_impact",
        label: "Production impact",
        type: "select",
        required: true,
        // Drives urgency. §3's SLA is about acknowledgement; this is about what happens next.
        options: ["Plant down", "Reduced output", "Redundancy lost", "No immediate impact"],
      },
      {
        key: "work_already_done",
        label: "What has already been tried",
        type: "text",
        required: false,
      },
      {
        key: "site_access",
        label: "Site access constraints",
        type: "text",
        required: false,
      },
    ],
  },
  {
    serviceType: "inspection",
    label: "Site inspection",
    fields: [
      {
        key: "purpose",
        label: "Purpose of the inspection",
        type: "text",
        required: true,
        help: "The question the visit has to answer.",
      },
      {
        key: "site_location",
        label: "Site and location within it",
        type: "text",
        required: true,
      },
      {
        key: "site_access",
        label: "Site access constraints",
        type: "text",
        required: true,
        help: "Gate pass lead time, induction, PPE, escort. The commonest cause of a wasted trip.",
      },
      {
        key: "required_outputs",
        label: "Required outputs",
        type: "text",
        required: false,
        help: "Photographs, tag list, measurements, sketch.",
      },
      {
        key: "preferred_dates",
        label: "Preferred date window",
        type: "text",
        required: false,
      },
    ],
  },
];

export interface MissingRequirement {
  serviceType: string;
  key: string;
  label: string;
}

export interface CompletenessResult {
  /** Templates that apply, derived from the inquiry's line items. */
  applicableServiceTypes: string[];
  requiredTotal: number;
  requiredAnswered: number;
  missing: MissingRequirement[];
  complete: boolean;
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  // A deliberate `false` on a boolean question is an answer. Only an empty string is not.
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Scores an inquiry's requirements against the templates its line items call for.
 *
 * An inquiry with no line items has no applicable template and is therefore trivially complete.
 * That is intentional: the gate exists to stop *unanswered questions* reaching a quotation, not to
 * force line items onto an inquiry that is genuinely a single-line enquiry. The empty case is worth
 * knowing about, so callers get `applicableServiceTypes` back and can say so on screen.
 */
export function assessRequirements(
  templates: readonly RequirementTemplateDef[],
  serviceTypes: readonly string[],
  requirements: Record<string, unknown> | null | undefined,
): CompletenessResult {
  const answers = requirements ?? {};
  const wanted = new Set(serviceTypes.filter(Boolean));

  const applicable = templates.filter((t) => wanted.has(t.serviceType));
  const missing: MissingRequirement[] = [];
  let requiredTotal = 0;
  let requiredAnswered = 0;

  for (const template of applicable) {
    for (const field of template.fields) {
      if (!field.required) continue;
      requiredTotal += 1;
      if (isAnswered(answers[answerKey(template.serviceType, field.key)])) {
        requiredAnswered += 1;
      } else {
        missing.push({ serviceType: template.serviceType, key: field.key, label: field.label });
      }
    }
  }

  return {
    applicableServiceTypes: applicable.map((t) => t.serviceType),
    requiredTotal,
    requiredAnswered,
    missing,
    complete: missing.length === 0,
  };
}
