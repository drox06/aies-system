-- specs/02-quotation.md §3.5: applying supplier costs back to the quotation needs to know which
-- quotation line each RFQ line was raised from. By line number, not by id — `QuotationLine` rows are
-- deleted and recreated on every save, so a foreign key to one would dangle.
--
-- Additive and nullable: a line typed straight into an RFQ has no source.

-- AlterTable
ALTER TABLE "SupplierQuoteLine" ADD COLUMN "sourceLineNo" INTEGER;
