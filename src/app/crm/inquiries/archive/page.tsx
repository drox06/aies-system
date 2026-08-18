"use client";

import { InquiryList } from "../page";

/**
 * The archive, as its own screen rather than a toggle on the live list.
 *
 * Asked for by the company in those terms — "a page where a table exists for archived inquiries,
 * this way all live inquiries and accomplished inquiries are separated". A separate URL is also
 * what makes it linkable and bookmarkable, and it keeps the live list's empty state honest: "no
 * inquiries yet" then means no *live* ones, which is the question somebody is actually asking.
 */
export default function ArchivedInquiriesPage() {
  return <InquiryList archived />;
}
