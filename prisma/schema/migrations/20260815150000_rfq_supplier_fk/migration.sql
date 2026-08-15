-- AddForeignKey
ALTER TABLE "SupplierQuoteRequest" ADD CONSTRAINT "SupplierQuoteRequest_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

