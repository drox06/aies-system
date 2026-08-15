-- AlterTable
ALTER TABLE "CustomerAccount" ADD COLUMN     "autoDormantAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PrincipalProspect" ADD COLUMN     "appointmentOverrideAt" TIMESTAMP(3),
ADD COLUMN     "appointmentOverrideBy" TEXT,
ADD COLUMN     "appointmentOverrideReason" TEXT;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "archivedAt" TIMESTAMP(3);
