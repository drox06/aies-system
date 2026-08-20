try {
  // .env is optional in CI, where real env vars are supplied directly (see prisma.config.ts).
  process.loadEnvFile(".env");
} catch {
  // ignore missing .env
}

/**
 * §2's task templates do not fire during the suite.
 *
 * ## Why this exists
 *
 * The suite creates real sales orders, tickets, cash advances and QA failures through the real
 * services, and those services `emit()` real domain events. Something in the run drains the job
 * queue, so those events reach every subscriber — including module 06's, which raised **278 real
 * tasks assigned to real people** on the first full run after templates landed. Each hung off a
 * fixture record that its own test then deleted.
 *
 * This is docs/DECISIONS.md #139 one layer deeper. Scoping `runTemplatesForEvent` fixed a test
 * calling it directly; nothing stopped an event *emitted* by a fixture from fanning out later. In a
 * platform with a separate test database this would not matter at all — there is not one (#1).
 *
 * ## What this flag does and does not cover
 *
 * It covers drains that happen **in this process** — the jobs tests, which call the drain directly.
 * It cannot cover the one that does most of the damage: `vercel.json` runs `/api/cron/drain` every
 * minute against the same database, so a fixture's event is picked up by the deployed application
 * seconds later, where no test env var exists. The sweep is the control for that; `npm test` prints
 * its count when the suite finishes. #142.
 *
 * ## Why the flag is read in the subscriber and not in the service
 *
 * The subscriber is the production path. `runTemplatesForEvent` is left working exactly as it does
 * in production, so `task-templates.test.ts` still exercises the real thing.
 */
process.env.AIES_DISABLE_TASK_TEMPLATES = "1";
