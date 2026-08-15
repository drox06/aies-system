import { z } from "zod";
import { protectedProcedure, router } from "@/server/api/trpc";
import {
  listEntityFilesService,
  removeEntityFileService,
} from "@/server/core/storage/file-service";

/**
 * The attachments on a record.
 *
 * **No `p("…")` gate on either procedure, and that is the point.** "Who may see the files on this
 * record" is not one permission — it is a different question for an accreditation certificate, a
 * supplier's quotation and a site photograph, and each module already answers it by registering a
 * checker (src/server/core/storage/access.ts). A permission here would either be so broad it
 * overrode those answers or so narrow it locked out the people the checkers exist to admit.
 *
 * Both procedures still require a signed-in user, and both run the registered checker before
 * returning or changing anything.
 */
export const filesRouter = router({
  forEntity: protectedProcedure
    .input(z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }))
    .query(({ ctx, input }) => listEntityFilesService(ctx.user, input)),

  remove: protectedProcedure
    .input(z.object({ fileId: z.string(), reason: z.string().max(300).nullish() }))
    .mutation(({ ctx, input }) => removeEntityFileService(ctx.user, ctx.user.name, input)),
});
