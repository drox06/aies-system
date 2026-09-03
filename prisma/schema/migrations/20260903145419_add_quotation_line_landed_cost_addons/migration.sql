-- AlterTable
ALTER TABLE "QuotationLine" ADD COLUMN     "dutiesTaxesPct" DECIMAL(7,4),
ADD COLUMN     "freightCostPct" DECIMAL(7,4),
ADD COLUMN     "localDeliveryCost" DECIMAL(14,2);
