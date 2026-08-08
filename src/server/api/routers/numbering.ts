import { z } from "zod";
import { previewNumber } from "@/server/core/numbering/numbering";
import { protectedProcedure, router } from "@/server/api/trpc";

export const numberingRouter = router({
  preview: protectedProcedure
    .input(z.object({ documentType: z.string() }))
    .query(({ input }) => previewNumber(input.documentType)),
});
