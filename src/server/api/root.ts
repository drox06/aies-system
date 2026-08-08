import { router } from "@/server/api/trpc";
import { adminRouter } from "@/server/api/routers/admin";
import { auditRouter } from "@/server/api/routers/audit";
import { authRouter } from "@/server/api/routers/auth";
import { numberingRouter } from "@/server/api/routers/numbering";
import { systemRouter } from "@/server/api/routers/system";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  audit: auditRouter,
  numbering: numberingRouter,
});

export type AppRouter = typeof appRouter;
