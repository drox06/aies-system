import { router } from "@/server/api/trpc";
import { adminRouter } from "@/server/api/routers/admin";
import { approvalsRouter } from "@/server/api/routers/approvals";
import { auditRouter } from "@/server/api/routers/audit";
import { authRouter } from "@/server/api/routers/auth";
import { commentsRouter } from "@/server/api/routers/comments";
import { customFieldsRouter } from "@/server/api/routers/custom-fields";
import { notifyRouter } from "@/server/api/routers/notify";
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
  notify: notifyRouter,
  approvals: approvalsRouter,
  comments: commentsRouter,
  search: searchRouter,
});

export type AppRouter = typeof appRouter;
