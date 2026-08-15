/**
 * Constants the §6 pipeline views share with the server.
 *
 * Pure — no Prisma — so My Day can state its own threshold instead of hardcoding a second copy of
 * the number the sweep uses. Same split as inquiry-lifecycle.ts and principal-lifecycle.ts, and the
 * `no-restricted-imports` rule in eslint.config.mjs is what caught the first attempt at putting
 * this in pipeline-service.ts.
 */

/**
 * specs/01-crm-inquiry.md §6: "accounts not contacted in N days". The N.
 *
 * Sixty because §1 picks the number itself — "who haven't I talked to in 60 days" — and it is the
 * question the whole CRM is said to be designed around. Configurable when module 09's settings
 * exist; one constant is the honest version of "not configurable yet".
 *
 * **What counts as contact changed at the company's instruction**, and the change is a real one:
 * see ACCOUNT_ACTIVITY_KINDS below. The number stayed at sixty.
 */
export const STALE_ACCOUNT_DAYS = 60;

/**
 * What the sixty-day clock actually measures.
 *
 * The original reading was §1's literal one — logged calls, meetings and site visits — on the
 * argument that editing a customer's address is not talking to them. That argument is still right
 * and the conclusion was still too narrow, which is what the company said: *"contact history should
 * count the 60 days not based on calls or contacts but on POs received on this particular
 * customer."*
 *
 * They are describing a different question, and a better one. A logged call is a record of somebody
 * remembering to log a call, and in a five-person firm that is uneven at best; a purchase order, a
 * quotation going out, an inquiry arriving are events the system observes whether or not anybody
 * writes them down. So the list now counts **business activity**, of which a logged call is one
 * kind rather than the only kind.
 *
 * The order here is the order of strength — a PO is the strongest evidence that a relationship is
 * alive, an edit to a record is not evidence at all and still does not appear.
 */
export const ACCOUNT_ACTIVITY_KINDS = [
  "purchase order received",
  "quotation sent",
  "inquiry received",
  "call, meeting or site visit",
] as const;

/**
 * When a customer with no purchase orders stops being called active.
 *
 * The company's number: *"log the customer dormant if AIES did not receive a PO from this customer
 * in 500 days."* Roughly sixteen months, which for industrial capital equipment is long enough to
 * clear a genuine multi-year replacement cycle and short enough that a lapsed relationship stops
 * flattering the pipeline.
 *
 * The clock runs from the last PO, or from the account's creation when there has never been one —
 * a prospect that has sat unbought for sixteen months is exactly what `dormant` is for.
 *
 * **`blacklisted` accounts are never touched.** That status is a deliberate decision by a person
 * with a reason behind it, and a nightly job quietly overwriting it with a milder one would erase
 * that reason on the day it mattered.
 */
export const DORMANT_WITHOUT_PO_DAYS = 500;

/**
 * How long a sent quotation may sit with no answer before somebody is told.
 *
 * The company's number, and their framing: *"a quote was sent to the customer and 7 days have
 * passed without feedback, make a notification that this item needs follow up."*
 *
 * Seven days is a week, which is how sales actually thinks about it, and it is deliberately far
 * shorter than the quotation's own validity window — §7's expiry catches the ones that died, and by
 * then it is a post-mortem. This one is meant to catch them while the customer still remembers the
 * conversation.
 */
export const QUOTE_SILENCE_FOLLOW_UP_DAYS = 7;
