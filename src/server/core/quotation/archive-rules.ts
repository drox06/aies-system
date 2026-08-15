/**
 * The archive's two constants, kept pure so the list screen can read them without pulling Prisma
 * into the browser bundle — the same split as pipeline-rules.ts and quotation-lifecycle.ts, and the
 * one the `no-restricted-imports` rule in eslint.config.mjs enforces.
 */

/**
 * How long a quotation stays on the working list after its purchase order arrives.
 *
 * The company's number. The fortnight after a PO is when people still open the quotation — checking
 * what was quoted against what the PO says, answering a scope question, chasing a discrepancy — so
 * archiving on receipt would hide the document during the only stretch it is still in daily use.
 */
export const ARCHIVE_AFTER_PO_DAYS = 14;

/**
 * Who may look at the archive: the president and the vice-president, at the company's instruction.
 *
 * Separate from `quotation.view`, which everybody in sales holds. The archive is the company's
 * finished business — every won deal, its margin, and what it was sold for — and the company's view
 * is that this is a management record rather than a working one.
 *
 * It gates the *list*, not the record. A quotation that has been archived still opens by id for
 * anybody who could open it before, because a link in an email from last year should not break and
 * because hiding a document somebody legitimately worked on is a different decision from keeping it
 * off their list.
 */
export const QUOTATION_ARCHIVE_PERMISSION = "quotation.view_archive";
