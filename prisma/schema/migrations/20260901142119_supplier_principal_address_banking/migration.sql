-- AlterTable
ALTER TABLE "PrincipalProspect" ADD COLUMN     "callingCardFileId" TEXT,
ADD COLUMN     "headOfficeAddress" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "plantAddress" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankAddress" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "plantAddress" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "swiftCode" TEXT,
ADD COLUMN     "tin" TEXT;
