import { router } from "@/server/api/trpc";
import { adminRouter } from "@/server/api/routers/admin";
import { authRouter } from "@/server/api/routers/auth";
import { systemRouter } from "@/server/api/routers/system";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
