import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/api/root";

/**
 * The builder's shape, taken from the procedure that produces it.
 *
 * Note what this type does *not* promise: `totalCost`, `marginAmount`, `marginPct` and the line
 * cost fields are stripped for a caller without `finance.view_cost`, so they are optional at the
 * type level too. Anything reading them has to handle their absence, which is the point — the
 * compiler will not let a margin panel assume a number it may never have been sent.
 */
export type QuotationDetail = inferRouterOutputs<AppRouter>["quotation"]["get"];

export type RevisionRow = inferRouterOutputs<AppRouter>["quotation"]["revisions"][number];
export type RevisionDiffResult = inferRouterOutputs<AppRouter>["quotation"]["diff"];
