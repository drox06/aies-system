-- The per-document checklist is gone. The documents AIES submits to *get* accredited (SEC
-- registration, BIR 2303, mayor's permit, PCAB licence) are lodged and tracked on each customer's
-- own portal, which is their authoritative record. Mirroring them here produced a second copy that
-- would drift, and made AIES's single mayor's permit expiry a value that had to be retyped on every
-- customer's record. See docs/DECISIONS.md #19.
--
-- Destructive by design: this drops the checklist data. It carried no information that is not on
-- the customers' portals.
ALTER TABLE "AccreditationRecord" DROP COLUMN "requirements";
