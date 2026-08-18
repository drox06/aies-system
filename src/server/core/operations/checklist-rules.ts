/**
 * specs/04-operations-projects.md §15, as pure functions.
 *
 * §15's opening line is the requirement: this "replaces the undocumented, verbal way work is
 * currently confirmed". A technician says the loop checked out, everybody believes them, and six
 * months later — when a customer disputes it or an auditor asks — there is nothing to read.
 *
 * ## The distinction the whole section rests on
 *
 * §15 offers both `pass_fail` and `pass_fail_na` as item types, and the difference is not
 * convenience. **A question nobody answered and a question answered "not applicable" are different
 * facts**, and only one of them is a decision somebody made. Offering N/A on an item where it is not
 * a legitimate answer is how a checklist becomes a formality — every awkward item gets an N/A and
 * the document ends up saying nothing.
 *
 * So the template author chooses, per item, whether "not applicable" is available at all; an unset
 * answer is never treated as one; and `checkResponse` reports the two separately. This is the sixth
 * place in the platform where the same rule appears (§7's diamond, §9's waiver, §10's witness,
 * docs/DECISIONS.md #65's default and #71's unknown coverage) and the first where it is expressed as
 * a *type* rather than as a field somebody remembered to add.
 */

// ---- item types ------------------------------------------------------------------------------

export const ITEM_TYPES = [
  "pass_fail",
  "pass_fail_na",
  "numeric",
  "text",
  "select_single",
  "select_multi",
  "photo",
  "signature",
  "instrument_reading",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  pass_fail: "Pass / fail",
  pass_fail_na: "Pass / fail / not applicable",
  numeric: "Number, with limits",
  text: "Written answer",
  select_single: "Choose one",
  select_multi: "Choose any",
  photo: "Photograph",
  signature: "Signature",
  instrument_reading: "Instrument reading, with unit",
};

/** The types on which "not applicable" is a legitimate answer. Deliberately short. */
const NA_ALLOWED: ReadonlySet<ItemType> = new Set<ItemType>(["pass_fail_na"]);

export function allowsNotApplicable(type: ItemType): boolean {
  return NA_ALLOWED.has(type);
}

export interface ChecklistItem {
  key: string;
  label: string;
  type: ItemType;
  required?: boolean;
  /** `numeric` and `instrument_reading`: the tolerance limits §15 asks for. */
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  /** `select_single` / `select_multi`. */
  options?: string[];
  /** Guidance under the label — what "pass" actually means for this item. */
  help?: string | null;
}

export interface ChecklistSection {
  key: string;
  title: string;
  items: ChecklistItem[];
}

export interface AnswerValue {
  value?: string | number | boolean | string[] | null;
  /** Only meaningful where `allowsNotApplicable`. Never inferred from an absent answer. */
  na?: boolean;
  note?: string | null;
  photoFileIds?: string[];
  /** §15's conditional logic: a fail reveals these, and they become mandatory. */
  cause?: string | null;
  action?: string | null;
}

export type Answers = Record<string, AnswerValue>;

// ---- reading what is stored -------------------------------------------------------------------

/**
 * Parses stored `sections` without trusting them.
 *
 * A template's Json can be older than the code reading it, and one malformed item should not take
 * out the whole checklist — an unreadable row is recoverable, a screen that throws is not. Unknown
 * item types are **dropped rather than guessed at**: rendering an unknown type as text would quietly
 * turn a numeric tolerance into a free-text box that accepts anything, which is the failure mode
 * this section exists to prevent.
 */
export function readSections(raw: unknown): ChecklistSection[] {
  if (!Array.isArray(raw)) return [];
  const types = new Set<string>(ITEM_TYPES);

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const section = entry as Record<string, unknown>;
    if (typeof section.key !== "string" || typeof section.title !== "string") return [];

    const rawItems = Array.isArray(section.items) ? section.items : [];
    const items = rawItems.flatMap((rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      if (typeof item.key !== "string" || typeof item.label !== "string") return [];
      if (typeof item.type !== "string" || !types.has(item.type)) return [];

      return [
        {
          key: item.key,
          label: item.label,
          type: item.type as ItemType,
          required: item.required !== false,
          min: typeof item.min === "number" ? item.min : null,
          max: typeof item.max === "number" ? item.max : null,
          unit: typeof item.unit === "string" ? item.unit : null,
          options: Array.isArray(item.options)
            ? item.options.filter((option): option is string => typeof option === "string")
            : undefined,
          help: typeof item.help === "string" ? item.help : null,
        } satisfies ChecklistItem,
      ];
    });

    return [{ key: section.key, title: section.title, items }];
  });
}

export function readAnswers(raw: unknown): Answers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Answers = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const answer = entry as Record<string, unknown>;
    out[key] = {
      value: answer.value as AnswerValue["value"],
      na: answer.na === true,
      note: typeof answer.note === "string" ? answer.note : null,
      photoFileIds: Array.isArray(answer.photoFileIds)
        ? answer.photoFileIds.filter((id): id is string => typeof id === "string")
        : [],
      cause: typeof answer.cause === "string" ? answer.cause : null,
      action: typeof answer.action === "string" ? answer.action : null,
    };
  }
  return out;
}

export const allItems = (sections: readonly ChecklistSection[]): ChecklistItem[] =>
  sections.flatMap((section) => section.items);

// ---- answering -------------------------------------------------------------------------------

/** Whether an item has been answered at all — as distinct from answered "not applicable". */
export function isAnswered(item: ChecklistItem, answer: AnswerValue | undefined): boolean {
  if (!answer) return false;
  if (answer.na) return true;

  switch (item.type) {
    case "photo":
      return (answer.photoFileIds?.length ?? 0) > 0;
    case "select_multi":
      return Array.isArray(answer.value) && answer.value.length > 0;
    case "text":
    case "signature":
      return typeof answer.value === "string" && answer.value.trim().length > 0;
    case "numeric":
    case "instrument_reading":
      return typeof answer.value === "number" && Number.isFinite(answer.value);
    default:
      return answer.value !== undefined && answer.value !== null && answer.value !== "";
  }
}

/** A `fail` on a pass/fail item, or a reading outside its limits. §15's conditional trigger. */
export function isFailure(item: ChecklistItem, answer: AnswerValue | undefined): boolean {
  if (!answer || answer.na) return false;

  if (item.type === "pass_fail" || item.type === "pass_fail_na") {
    return answer.value === "fail" || answer.value === false;
  }

  if (item.type === "numeric" || item.type === "instrument_reading") {
    if (typeof answer.value !== "number" || !Number.isFinite(answer.value)) return false;
    // An item with no limits set cannot fail this way. It is a record, not a judgement, and treating
    // "no limits" as "everything fails" would be nonsense.
    if (typeof item.min === "number" && answer.value < item.min) return true;
    if (typeof item.max === "number" && answer.value > item.max) return true;
  }

  return false;
}

export interface ItemProblem {
  itemKey: string;
  label: string;
  reason: string;
}

export interface ChecklistCheck {
  ok: boolean;
  /** Required items with no answer at all. */
  unanswered: ItemProblem[];
  /** Failures whose §15 cause and action are missing. */
  incompleteFailures: ItemProblem[];
  /** "Not applicable" recorded on an item that never offered it. */
  invalidNotApplicable: ItemProblem[];
  /** The failures themselves — the reason a checklist is worth reading at all. */
  failures: ItemProblem[];
  answeredCount: number;
  requiredCount: number;
}

/**
 * Whether this response may be completed, and what is in the way.
 *
 * §15's conditional logic lives here: "a `fail` reveals mandatory cause and action fields". They are
 * mandatory *because* something failed, so they cannot be expressed as `required` on the item — which
 * is why completeness is computed rather than read off the template.
 */
export function checkResponse(
  sections: readonly ChecklistSection[],
  answers: Answers,
): ChecklistCheck {
  const unanswered: ItemProblem[] = [];
  const incompleteFailures: ItemProblem[] = [];
  const invalidNotApplicable: ItemProblem[] = [];
  const failures: ItemProblem[] = [];

  let answeredCount = 0;
  let requiredCount = 0;

  for (const item of allItems(sections)) {
    const answer = answers[item.key];
    if (item.required !== false) requiredCount += 1;

    // An N/A on an item that never offered it is not a lesser answer — it is a claim the template
    // did not authorise, and accepting it quietly would let any item be skipped by writing one word.
    if (answer?.na && !allowsNotApplicable(item.type)) {
      invalidNotApplicable.push({
        itemKey: item.key,
        label: item.label,
        reason:
          `"${ITEM_TYPE_LABELS[item.type]}" does not offer "not applicable". ` +
          `This one has to be answered.`,
      });
      continue;
    }

    if (isAnswered(item, answer)) answeredCount += 1;
    else if (item.required !== false) {
      unanswered.push({ itemKey: item.key, label: item.label, reason: "Not answered." });
      continue;
    }

    if (isFailure(item, answer)) {
      failures.push({
        itemKey: item.key,
        label: item.label,
        reason: describeFailure(item, answer),
      });

      const missing: string[] = [];
      if (!answer?.cause?.trim()) missing.push("cause");
      if (!answer?.action?.trim()) missing.push("action");
      if (missing.length > 0) {
        incompleteFailures.push({
          itemKey: item.key,
          label: item.label,
          reason: `A failure needs its ${missing.join(" and ")} recorded — that is the part somebody acts on.`,
        });
      }
    }
  }

  return {
    ok:
      unanswered.length === 0 &&
      incompleteFailures.length === 0 &&
      invalidNotApplicable.length === 0,
    unanswered,
    incompleteFailures,
    invalidNotApplicable,
    failures,
    answeredCount,
    requiredCount,
  };
}

function describeFailure(item: ChecklistItem, answer: AnswerValue | undefined): string {
  if (item.type === "numeric" || item.type === "instrument_reading") {
    const unit = item.unit ? ` ${item.unit}` : "";
    const low = typeof item.min === "number" ? item.min : null;
    const high = typeof item.max === "number" ? item.max : null;
    const range =
      low !== null && high !== null
        ? `${low} to ${high}${unit}`
        : low !== null
          ? `at least ${low}${unit}`
          : `at most ${high}${unit}`;
    return `Read ${String(answer?.value)}${unit}, outside ${range}.`;
  }
  return "Failed.";
}

// ---- what happens afterwards --------------------------------------------------------------------

/**
 * Failures serious enough for module 08 to raise an NCR against.
 *
 * §15 says a fail "can auto-raise an NCR". Module 04 does not own NCRs — specs/08-qms-iso9001.md §2
 * does — so this computes *which* and leaves the raising to the module with the register, exactly as
 * §9's `ncrWorthyDefects` already does. Deciding it now means module 08 has something to subscribe
 * to rather than a retrofit through every caller.
 */
export function ncrWorthy(check: ChecklistCheck): ItemProblem[] {
  return check.failures;
}

/** One line for a list, saying the thing somebody scanning actually wants. */
export function summarise(check: ChecklistCheck): string {
  if (check.failures.length > 0) {
    return `${check.failures.length} failed of ${check.requiredCount}`;
  }
  if (!check.ok) return `${check.answeredCount} of ${check.requiredCount} answered`;
  return `All ${check.requiredCount} passed`;
}

export const CHECKLIST_TEMPLATE_ENTITY_TYPE = "ChecklistTemplate";
export const CHECKLIST_RESPONSE_ENTITY_TYPE = "ChecklistResponse";
export const CHECKLIST_FILL_PERMISSION = "checklist.fill";
export const CHECKLIST_MANAGE_PERMISSION = "checklist.manage";
