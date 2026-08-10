-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "paymentTermsText" TEXT,
ADD COLUMN     "termsAndConditions" JSONB NOT NULL DEFAULT '[]';

