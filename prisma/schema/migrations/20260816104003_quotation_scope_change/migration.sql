-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "scopeChangeChasedAt" TIMESTAMP(3),
ADD COLUMN     "scopeChangeFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "scopeChangeInspectionId" TEXT,
ADD COLUMN     "scopeChangeNotes" TEXT,
ADD COLUMN     "scopeChangeResolution" TEXT,
ADD COLUMN     "scopeChangeResolutionNote" TEXT,
ADD COLUMN     "scopeChangeResolvedAt" TIMESTAMP(3),
ADD COLUMN     "scopeChangeResolvedById" TEXT,
ADD COLUMN     "scopeChangeSource" TEXT;

-- CreateIndex
CREATE INDEX "Quotation_scopeChangeFlaggedAt_scopeChangeResolvedAt_idx" ON "Quotation"("scopeChangeFlaggedAt", "scopeChangeResolvedAt");
