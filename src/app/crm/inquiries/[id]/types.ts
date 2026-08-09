import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/api/root";

/**
 * The record page's shape, taken from the procedure that produces it rather than restated.
 *
 * Type-only, so nothing server-side reaches the browser bundle. Restating it by hand is how a
 * panel keeps rendering a field the API stopped sending.
 */
export type InquiryDetail = inferRouterOutputs<AppRouter>["crm"]["getInquiry"];
