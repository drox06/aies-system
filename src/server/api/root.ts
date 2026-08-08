import { router } from "@/server/api/trpc";
import { systemRouter } from "@/server/api/routers/system";

export const appRouter = router({
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
