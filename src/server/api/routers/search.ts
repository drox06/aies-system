import { z } from "zod";
import { search } from "@/server/core/search/query";
import { protectedProcedure, router } from "@/server/api/trpc";

export const searchRouter = router({
  query: protectedProcedure
    .input(z.object({ q: z.string() }))
    .query(({ input }) => search(input.q)),
});
