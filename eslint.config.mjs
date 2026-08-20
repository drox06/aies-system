import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * Modules under `src/server/` that a component may import.
 *
 * An allow-list, not a deny-list. The rule this enforces was learned the expensive way: a client
 * component imported `inspection-service.ts` for one string constant, which pulled in Prisma and
 * the numbering service and therefore `node:crypto`, and `next build` failed outright with
 * "Reading from node:crypto is not handled by plugins". `npm run typecheck` passed clean — only the
 * production build caught it, at the very end of a session.
 *
 * A deny-list of `*-service` would have caught that one case and missed `@/lib/db`,
 * `@/server/auth`, or a service that happens to be named something else. So: everything under
 * `src/server/` is off-limits to a component except the files below, each of which is deliberately
 * pure — no Prisma, no node builtins, nothing but rules and constants the UI genuinely shares with
 * the server so the two cannot drift apart.
 *
 * Adding a file here is a real decision. It must import nothing that reaches the database.
 */
const UI_SAFE_SERVER_MODULES = [
  "@/server/core/crm/inquiry-lifecycle",
  "@/server/core/crm/accreditation-rules",
  "@/server/core/crm/requirements",
  "@/server/core/crm/principal-lifecycle",
  "@/server/core/crm/pipeline-rules",
  "@/server/core/quotation/costing",
  "@/server/core/quotation/quotation-number",
  "@/server/core/quotation/quotation-lifecycle",
  "@/server/core/quotation/archive-rules",
  // AIES's own registered details. A file of constants behind a getter — no Prisma, no node
  // builtins — and the screens need it for the same reason the PDFs do: the delivery address a
  // buyer sees offered as the default must be the one that will actually print.
  "@/server/core/company",
  "@/server/core/order/supplier-rules",
  "@/server/core/order/supplier-po-rules",
  "@/server/core/order/goods-receipt-rules",
  // Module 05's rules files. All pure — no Prisma, no node builtins — and the screens need
  // them for the same reason every other entry here exists: the labels and buckets a person reads
  // must be the ones the service computed, not a second copy that drifts. `expense-rules` was split
  // out of `expense-service` on 2026-08-20 because this guard refused the screen's import — which is
  // the guard working: that file pulls Prisma and would have failed `next build`.
  "@/server/core/finance/billing-rules",
  "@/server/core/finance/invoice-rules",
  "@/server/core/finance/collection-rules",
  "@/server/core/finance/project-pnl-rules",
  "@/server/core/finance/payables-rules",
  "@/server/core/finance/export-rules",
  "@/server/core/finance/expense-rules",
  "@/server/core/operations/ticket-rules",
  "@/server/core/operations/cash-advance-rules",
  "@/server/core/operations/site-inspection-rules",
  "@/server/core/operations/methodology-rules",
  "@/server/core/operations/material-request-rules",
  "@/server/core/operations/mobilization-rules",
  "@/server/core/operations/daily-progress-rules",
  "@/server/core/operations/qa-rules",
  "@/server/core/operations/tc-rules",
  "@/server/core/operations/warranty-rules",
  "@/server/core/operations/close-out-rules",
  "@/server/core/operations/delivery-rules",
  "@/server/core/operations/checklist-rules",
  "@/server/core/operations/renewal-rules",
  "@/server/core/operations/timesheet-rules",
  "@/server/core/operations/dispatch-rules",
  "@/server/core/order/po-verification",
  // Module 06's task rules. Pure — the statuses, priorities, the urgency bands My Work sorts on,
  // and the map from a task's entityType to the record's own screen. Listed for the reason every
  // entry here exists: a screen that recomputed "overdue" would eventually disagree with the server
  // about which tasks are late.
  "@/server/core/collab/task-rules",
  // The template shapes and the three assignment modes, with their explanations. The templates
  // screen exists to say what the platform will do without being asked; if it described the modes
  // in its own words they would eventually stop being what the service does.
  "@/server/core/collab/task-template-rules",
  // The board rules: what a column is, when one is over its WIP limit, what a smart board's filter
  // says. The board screen renders all three, and a second copy on the client is a second answer
  // waiting to disagree with the server's.
  "@/server/core/collab/board-rules",
  "@/server/core/calendar/business-days",
  // Type-only: the router's inferred output types. Erased at compile time, so it carries no runtime
  // weight — but it is listed rather than assumed, because a value import from here would.
  "@/server/api/root",
];

/**
 * `regex` rather than `group`, because gitignore-style `!` negation inside a `group` does not
 * actually exempt the allowed paths here — it was tried, and it flagged every one of them. A
 * negative lookahead leaves no room for interpretation.
 */
const RESTRICTED_SERVER_IMPORTS = new RegExp(
  `^@/lib/db$|^@/server/(?!(?:${UI_SAFE_SERVER_MODULES.map((m) =>
    m.replace("@/server/", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})$)`,
).source;

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
  {
    // Components only. Route handlers under src/app/api are `.ts` and legitimately reach the
    // database — `/api/cron/nightly` exists precisely to call services.
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: RESTRICTED_SERVER_IMPORTS,
              message:
                "A component may not import server code. It pulls Prisma and node builtins into " +
                "the browser bundle and fails `next build` — which typecheck does not catch. Put " +
                "shared rules and constants in a pure file (inquiry-lifecycle.ts, " +
                "accreditation-rules.ts, requirements.ts) and add it to UI_SAFE_SERVER_MODULES in " +
                "eslint.config.mjs. Fetch data through tRPC.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      // build:check writes here (see next.config.ts). Generated output is not source.
      ".next-build/**",
      "docker/**",
      "prisma/schema/**/*.prisma",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
