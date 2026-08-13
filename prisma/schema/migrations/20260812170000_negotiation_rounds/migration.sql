-- specs/02-quotation.md §8's negotiation log and win/loss fields.
--
-- Additive. `lostReason` and `competitor` are new columns rather than a reuse of `rejectionReason`,
-- which records why the VP sent a quotation back to draft — a report on internal rework and a report
-- on lost business must not read from the same column.

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "competitor" TEXT;

-- CreateTable
CREATE TABLE "NegotiationRound" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerPosition" TEXT NOT NULL,
    "aiesResponse" TEXT NOT NULL,
    "authorisedById" TEXT NOT NULL,
    "resultingQuotationId" TEXT,
    "agreedTotal" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationRound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NegotiationRound_quotationId_roundNo_key" ON "NegotiationRound"("quotationId", "roundNo");

-- CreateIndex
CREATE INDEX "NegotiationRound_quotationId_idx" ON "NegotiationRound"("quotationId");

-- AddForeignKey
ALTER TABLE "NegotiationRound" ADD CONSTRAINT "NegotiationRound_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
