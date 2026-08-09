/**
 * Constants the §6 pipeline views share with the server.
 *
 * Pure — no Prisma — so My Day can state its own threshold instead of hardcoding a second copy of
 * the number the sweep uses. Same split as inquiry-lifecycle.ts and principal-lifecycle.ts, and the
 * `no-restricted-imports` rule in eslint.config.mjs is what caught the first attempt at putting
 * this in pipeline-service.ts.
 */

/**
 * specs/01-crm-inquiry.md §6: "accounts not contacted in N days". The N.
 *
 * Sixty because §1 picks the number itself — "who haven't I talked to in 60 days" — and it is the
 * question the whole CRM is said to be designed around. Configurable when module 09's settings
 * exist; one constant is the honest version of "not configurable yet".
 */
export const STALE_ACCOUNT_DAYS = 60;
