/**
 * §6's expense vocabulary — the categories and their labels, and nothing that touches a database.
 *
 * Pure, and on `UI_SAFE_SERVER_MODULES` in eslint.config.mjs, so the screen and the server name the
 * same seven things. The first version of the expenses screen imported these straight from
 * `expense-service.ts` and the lint guard refused it — correctly: that file pulls Prisma, which
 * compiles fine and then fails `next build` with the whole client bundle behind it.
 *
 * The categories deliberately mirror `EXPENSE_CATEGORY` in project-pnl-service.ts, which maps each
 * onto one of §6's eight P&L categories. A category added here without a mapping there would land
 * silently in "Other" on every P&L — so they are kept in sight of each other, and the mapping is
 * exhaustive rather than defaulted.
 */

export const EXPENSE_CATEGORIES = [
  "subcontract",
  "rental",
  "equipment",
  "permits",
  "materials",
  "travel",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  subcontract: "Subcontractor",
  rental: "Rental",
  equipment: "Equipment",
  permits: "Permit or fee",
  materials: "Materials",
  travel: "Travel and site costs",
  other: "Other",
};

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}
