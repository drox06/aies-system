import { router } from "@/server/api/trpc";
import { adminRouter } from "@/server/api/routers/admin";
import { approvalsRouter } from "@/server/api/routers/approvals";
import { auditRouter } from "@/server/api/routers/audit";
import { authRouter } from "@/server/api/routers/auth";
import { commentsRouter } from "@/server/api/routers/comments";
import { crmRouter } from "@/server/api/routers/crm";
import { quotationRouter } from "@/server/api/routers/quotation";
import { customFieldsRouter } from "@/server/api/routers/custom-fields";
import { filesRouter } from "@/server/api/routers/files";
import { notifyRouter } from "@/server/api/routers/notify";
import { operationsRouter } from "@/server/api/routers/operations";
import { financeRouter } from "@/server/api/routers/finance";
import { orderRouter } from "@/server/api/routers/order";
import { numberingRouter } from "@/server/api/routers/numbering";
import { searchRouter } from "@/server/api/routers/search";
import { systemRouter } from "@/server/api/routers/system";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  audit: auditRouter,
  numbering: numberingRouter,
  customFields: customFieldsRouter,
  files: filesRouter,
  notify: notifyRouter,
  approvals: approvalsRouter,
  comments: commentsRouter,
  search: searchRouter,
  crm: crmRouter,
  quotation: quotationRouter,
  finance: financeRouter,
  order: orderRouter,
  operations: operationsRouter,
});

export type AppRouter = typeof appRouter;
