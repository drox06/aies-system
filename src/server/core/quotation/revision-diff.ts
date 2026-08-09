/**
 * The revision diff (specs/02-quotation.md §5).
 *
 * §5 says why it exists and it is not a nicety: "Sales needs this in front of them during
 * negotiation calls." The question being answered on the phone is "what changed since R1?", and the
 * answer has to be specific enough to read aloud.
 *
 * Pure, so the same comparison runs in the builder and in the PDF.
 */

export interface DiffLine {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  isOptional: boolean;
}

export interface DiffTerms {
  validUntil: string | null;
  deliveryLeadTime: string | null;
  paymentTermsId: string | null;
  warrantyTerms: string | null;
  exclusions: string | null;
  assumptions: string | null;
  total: string;
}

export interface DiffSide {
  label: string;
  lines: DiffLine[];
  terms: DiffTerms;
}

export type LineChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface LineChange {
  kind: LineChangeKind;
  description: string;
  /** Present on `changed`: only the fields that actually moved. */
  changes?: {
    field: "quantity" | "unitPrice" | "lineTotal" | "isOptional";
    from: string;
    to: string;
  }[];
  before?: DiffLine;
  after?: DiffLine;
}

export interface TermChange {
  field: keyof DiffTerms;
  from: string | null;
  to: string | null;
}

export interface RevisionDiff {
  fromLabel: string;
  toLabel: string;
  lines: LineChange[];
  terms: TermChange[];
  /** True when nothing moved — worth saying out loud rather than showing an empty panel. */
  identical: boolean;
}

/**
 * Matches lines between two revisions by description rather than by line number.
 *
 * Line numbers are positional: inserting a line at the top would otherwise report every line below
 * it as "changed", which is noise precisely when someone is reading the diff aloud. Descriptions
 * are what a person recognises, and a renamed line honestly *is* a removal plus an addition — the
 * customer sees a different line item.
 *
 * Duplicate descriptions within one revision are matched in order, so two "Flow meter" lines pair
 * with the other revision's first and second.
 */
function keyOf(line: DiffLine, seen: Map<string, number>): string {
  const base = line.description.trim().toLowerCase();
  const occurrence = (seen.get(base) ?? 0) + 1;
  seen.set(base, occurrence);
  return `${base}#${occurrence}`;
}

export function diffRevisions(before: DiffSide, after: DiffSide): RevisionDiff {
  const beforeSeen = new Map<string, number>();
  const afterSeen = new Map<string, number>();
  const beforeByKey = new Map(before.lines.map((line) => [keyOf(line, beforeSeen), line]));
  const afterByKey = new Map(after.lines.map((line) => [keyOf(line, afterSeen), line]));

  const lines: LineChange[] = [];

  // Walk the new revision in its own order, so the diff reads in the order the customer will see.
  for (const [key, afterLine] of afterByKey) {
    const beforeLine = beforeByKey.get(key);
    if (!beforeLine) {
      lines.push({ kind: "added", description: afterLine.description, after: afterLine });
      continue;
    }

    const changes: NonNullable<LineChange["changes"]> = [];
    if (beforeLine.quantity !== afterLine.quantity) {
      changes.push({ field: "quantity", from: beforeLine.quantity, to: afterLine.quantity });
    }
    if (beforeLine.unitPrice !== afterLine.unitPrice) {
      changes.push({ field: "unitPrice", from: beforeLine.unitPrice, to: afterLine.unitPrice });
    }
    if (beforeLine.lineTotal !== afterLine.lineTotal) {
      changes.push({ field: "lineTotal", from: beforeLine.lineTotal, to: afterLine.lineTotal });
    }
    if (beforeLine.isOptional !== afterLine.isOptional) {
      changes.push({
        field: "isOptional",
        from: String(beforeLine.isOptional),
        to: String(afterLine.isOptional),
      });
    }

    lines.push({
      kind: changes.length > 0 ? "changed" : "unchanged",
      description: afterLine.description,
      changes: changes.length > 0 ? changes : undefined,
      before: beforeLine,
      after: afterLine,
    });
  }

  // Anything in the old revision the new one no longer has.
  for (const [key, beforeLine] of beforeByKey) {
    if (!afterByKey.has(key)) {
      lines.push({ kind: "removed", description: beforeLine.description, before: beforeLine });
    }
  }

  const terms: TermChange[] = [];
  for (const field of Object.keys(after.terms) as (keyof DiffTerms)[]) {
    const from = before.terms[field] ?? null;
    const to = after.terms[field] ?? null;
    if (from !== to) terms.push({ field, from, to });
  }

  return {
    fromLabel: before.label,
    toLabel: after.label,
    lines,
    terms,
    identical: terms.length === 0 && lines.every((line) => line.kind === "unchanged"),
  };
}
