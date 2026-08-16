-- AlterTable
ALTER TABLE "DocumentSequence" ADD COLUMN     "format" TEXT;

-- CreateIndex
CREATE INDEX "DocumentSequence_documentType_idx" ON "DocumentSequence"("documentType");

-- Backfill every existing counter with the format it is currently being advanced under.
--
-- Without this, every row predating the column reads as "format unknown", and the guard in
-- allocateNumber has nothing to compare against — the check would be inert on exactly the
-- installations that already have live counters, which is all of them.
UPDATE "DocumentSequence" ds
SET "format" = nf."format"
FROM "NumberingFormat" nf
WHERE nf."documentType" = ds."documentType"
  AND ds."format" IS NULL;
