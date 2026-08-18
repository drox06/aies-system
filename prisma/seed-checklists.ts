/**
 * specs/04-operations-projects.md §15's seeded checklists.
 *
 * §15 names eleven stages by hand: "site inspection, mobilization readiness, material issue and
 * return, instrument installation, loop check, QA inspection, T&C functional test, safety toolbox
 * talk / JSA, PM visit, demobilization and site clearance, delivery attempt." These are those, with
 * items drawn from what the surrounding sections already require — §8's clearances, §9's defects,
 * §10's functional tests, §13's failure causes — so a checklist asks for the same facts the gate
 * further down the flowchart is going to want.
 *
 * ## They are a starting point, not the company's procedure
 *
 * The seed creates a version 1 only where nothing exists under that key. It **never** rewrites an
 * existing one, and in particular never touches `sections` on a published version: responses cite a
 * version as the procedure they followed, so overwriting it on the next deploy would silently
 * rewrite what somebody signed. The company revises these through the app, and the seed then leaves
 * them alone forever.
 *
 * ## Where "not applicable" is offered, and where it is not
 *
 * Deliberate, item by item. `pass_fail_na` appears only where a site can genuinely lack the thing —
 * no scaffolding on a ground-level job, no permit where none is required. Everything a technician
 * must actually confirm is `pass_fail`, which offers no way out. See checklist-rules.ts.
 */

export interface SeedItem {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  min?: number;
  max?: number;
  unit?: string;
  options?: string[];
  help?: string;
}

export interface SeedSection {
  key: string;
  title: string;
  items: SeedItem[];
}

export interface SeedChecklist {
  key: string;
  name: string;
  stage: string;
  description: string;
  sections: SeedSection[];
}

export const SEED_CHECKLISTS: SeedChecklist[] = [
  {
    key: "site_inspection",
    name: "Site inspection",
    stage: "pre_quotation",
    description: "§6.1's survey, in the form the quotation will be built from.",
    sections: [
      {
        key: "access",
        title: "Access and conditions",
        items: [
          { key: "site_reachable", label: "Site reachable by service vehicle", type: "pass_fail" },
          {
            key: "working_at_height",
            label: "Work at height required",
            type: "pass_fail_na",
            help: "Not applicable where everything is at ground level.",
          },
          { key: "power_available", label: "Power available at the work area", type: "pass_fail" },
          { key: "site_photos", label: "Photographs of the work area", type: "photo" },
        ],
      },
      {
        key: "scope",
        title: "What is actually there",
        items: [
          {
            key: "equipment_found",
            label: "Equipment and tag numbers found on site",
            type: "text",
          },
          {
            key: "differs_from_enquiry",
            label: "Scope differs from what the customer described",
            type: "pass_fail",
            help: "A failure here is a scope change, and §6.1 links it to the quotation.",
          },
        ],
      },
    ],
  },
  {
    key: "mobilization_readiness",
    name: "Mobilisation readiness",
    stage: "mobilization",
    description: "§8's gate: nothing leaves the yard until these are true.",
    sections: [
      {
        key: "clearances",
        title: "Clearances",
        items: [
          { key: "gate_pass", label: "Gate pass issued", type: "pass_fail" },
          { key: "work_permit", label: "Work permit issued", type: "pass_fail" },
          {
            key: "hot_work_permit",
            label: "Hot work permit",
            type: "pass_fail_na",
            help: "Not applicable where no hot work is planned.",
          },
          { key: "safety_induction", label: "Site safety induction completed", type: "pass_fail" },
        ],
      },
      {
        key: "readiness",
        title: "Crew and kit",
        items: [
          {
            key: "materials_issued",
            label: "Materials issued against the request",
            type: "pass_fail",
          },
          { key: "tools_complete", label: "Tools and instruments complete", type: "pass_fail" },
          { key: "ppe_complete", label: "PPE complete for every crew member", type: "pass_fail" },
          {
            key: "cash_advance",
            label: "Cash advance released where required",
            type: "pass_fail_na",
          },
        ],
      },
    ],
  },
  {
    key: "material_issue_return",
    name: "Material issue and return",
    stage: "materials",
    description: "§7's store movements, counted rather than remembered.",
    sections: [
      {
        key: "issue",
        title: "On issue",
        items: [
          {
            key: "against_request",
            label: "Every item matches the material request",
            type: "pass_fail",
          },
          {
            key: "quantities_counted",
            label: "Quantities counted at the counter",
            type: "pass_fail",
          },
          {
            key: "condition_ok",
            label: "Items undamaged and within calibration",
            type: "pass_fail",
          },
        ],
      },
      {
        key: "return",
        title: "On return",
        items: [
          { key: "unused_returned", label: "Unused material returned to store", type: "pass_fail" },
          {
            key: "quantity_returned",
            label: "Quantity returned",
            type: "numeric",
            required: false,
          },
          { key: "damage_noted", label: "Damage or shortage found", type: "pass_fail" },
        ],
      },
    ],
  },
  {
    key: "instrument_installation",
    name: "Instrument installation",
    stage: "execution",
    description: "What was installed, where, and to whose drawing.",
    sections: [
      {
        key: "install",
        title: "Installation",
        items: [
          { key: "tag_number", label: "Tag number", type: "text" },
          { key: "serial_number", label: "Serial number", type: "text" },
          { key: "per_drawing", label: "Installed per approved drawing", type: "pass_fail" },
          {
            key: "orientation",
            label: "Orientation and process connection correct",
            type: "pass_fail",
          },
          { key: "earthing", label: "Earthing and bonding complete", type: "pass_fail" },
          { key: "nameplate_photo", label: "Photograph of the nameplate in place", type: "photo" },
        ],
      },
    ],
  },
  {
    key: "loop_check",
    name: "Loop check",
    stage: "execution",
    description: "The reading that says the loop works, with its limits.",
    sections: [
      {
        key: "loop",
        title: "Signal",
        items: [
          {
            key: "zero_reading",
            label: "Reading at 0%",
            type: "instrument_reading",
            unit: "mA",
            min: 3.9,
            max: 4.1,
          },
          {
            key: "span_reading",
            label: "Reading at 100%",
            type: "instrument_reading",
            unit: "mA",
            min: 19.9,
            max: 20.1,
          },
          { key: "dcs_matches", label: "Value at the DCS matches the field", type: "pass_fail" },
          { key: "continuity", label: "Cable continuity and shield verified", type: "pass_fail" },
        ],
      },
    ],
  },
  {
    key: "qa_inspection",
    name: "QA inspection",
    stage: "qa",
    description: "§9's gate. A failure here returns the ticket to work.",
    sections: [
      {
        key: "workmanship",
        title: "Workmanship",
        items: [
          {
            key: "to_specification",
            label: "Work matches the approved specification",
            type: "pass_fail",
          },
          { key: "terminations", label: "Terminations tight and labelled", type: "pass_fail" },
          { key: "housekeeping", label: "Work area clean and clear", type: "pass_fail" },
          { key: "evidence_photos", label: "Photographs of the finished work", type: "photo" },
        ],
      },
      {
        key: "documents",
        title: "Documents",
        items: [
          { key: "asbuilt_updated", label: "As-built marked up", type: "pass_fail_na" },
          {
            key: "calibration_certs",
            label: "Calibration certificates attached",
            type: "pass_fail_na",
          },
        ],
      },
    ],
  },
  {
    key: "tc_functional_test",
    name: "T&C functional test",
    stage: "testing_commissioning",
    description: "§10's functional test, against the criteria that were promised.",
    sections: [
      {
        key: "function",
        title: "Function",
        items: [
          { key: "powers_up", label: "Powers up and self-tests clean", type: "pass_fail" },
          { key: "alarms", label: "Alarms and interlocks operate", type: "pass_fail" },
          {
            key: "process_reading",
            label: "Process reading under running conditions",
            type: "instrument_reading",
            required: false,
          },
          { key: "customer_witnessed", label: "Witnessed by the customer", type: "pass_fail_na" },
        ],
      },
    ],
  },
  {
    key: "toolbox_talk_jsa",
    name: "Safety toolbox talk / JSA",
    stage: "safety",
    description: "Before work starts, every day it starts.",
    sections: [
      {
        key: "talk",
        title: "Toolbox talk",
        items: [
          { key: "hazards_identified", label: "Hazards identified and discussed", type: "text" },
          { key: "controls_agreed", label: "Controls agreed with the crew", type: "pass_fail" },
          {
            key: "emergency_route",
            label: "Muster point and emergency route covered",
            type: "pass_fail",
          },
          { key: "attendees", label: "Who attended", type: "text" },
          { key: "crew_signature", label: "Crew lead signature", type: "signature" },
        ],
      },
    ],
  },
  {
    key: "pm_visit",
    name: "Preventive maintenance visit",
    stage: "after_sales",
    description: "§16's contract visit, so the next one starts from a record.",
    sections: [
      {
        key: "pm",
        title: "Maintenance",
        items: [
          { key: "cleaned", label: "Cleaned and inspected", type: "pass_fail" },
          {
            key: "calibration_checked",
            label: "Calibration checked against reference",
            type: "pass_fail",
          },
          { key: "consumables", label: "Consumables replaced", type: "pass_fail_na" },
          {
            key: "condition",
            label: "Overall condition",
            type: "select_single",
            options: ["Good", "Serviceable", "Needs attention"],
          },
          {
            key: "recommendations",
            label: "Recommendations for the customer",
            type: "text",
            required: false,
          },
        ],
      },
    ],
  },
  {
    key: "demobilization_site_clearance",
    name: "Demobilisation and site clearance",
    stage: "demobilization",
    description: "§8's other end. What the customer sees after the crew leaves.",
    sections: [
      {
        key: "clearance",
        title: "Clearance",
        items: [
          {
            key: "tools_accounted",
            label: "All tools and instruments accounted for",
            type: "pass_fail",
          },
          {
            key: "waste_removed",
            label: "Waste and packaging removed from site",
            type: "pass_fail",
          },
          { key: "area_restored", label: "Work area restored", type: "pass_fail" },
          {
            key: "permits_closed",
            label: "Permits closed out with the customer",
            type: "pass_fail",
          },
          { key: "clearance_photo", label: "Photograph of the cleared area", type: "photo" },
          {
            key: "customer_ack",
            label: "Customer representative acknowledgement",
            type: "signature",
          },
        ],
      },
    ],
  },
  {
    key: "delivery_attempt",
    name: "Delivery attempt",
    stage: "delivery",
    description: "§13's visit, recorded at the gate.",
    sections: [
      {
        key: "attempt",
        title: "At the site",
        items: [
          { key: "contact_reached", label: "Named contact reached", type: "pass_fail" },
          { key: "goods_condition", label: "Goods undamaged on arrival", type: "pass_fail" },
          {
            key: "quantities_match",
            label: "Quantities match the delivery receipt",
            type: "pass_fail",
          },
          { key: "delivery_photo", label: "Photograph of the goods delivered", type: "photo" },
          {
            key: "receiver_signature",
            label: "Signature of whoever received them",
            type: "signature",
          },
        ],
      },
    ],
  },
];
