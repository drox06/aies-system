import { NextResponse } from "next/server";
import { icsFeedService } from "@/server/core/collab/calendar-service";

/**
 * §4's iCal feed: *"token-authenticated, so it can appear in their phone calendar."*
 *
 * ## Why there is no session here
 *
 * A phone's calendar client cannot log in. It fetches a URL every half hour with no cookies and no
 * headers of ours, so the token in the path **is** the identity — which is how every calendar
 * subscription in existence works, and worth being clear-eyed about: anybody holding this URL can
 * read that person's schedule. It is 32 random bytes, it is one person's, `lastUsedAt` shows whether
 * it is still in use, and rotating it kills the old link the moment somebody rotates.
 *
 * ## Read-only, permanently
 *
 * §4 rules out two-way Google sync in v1 — *"a large source of bugs and duplicate events"* — so this
 * answers GET and nothing else.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const ics = await icsFeedService(token);
  if (!ics) {
    /*
      404, not 401.

      A wrong token and a revoked one look identical from outside, which is what we want: an
      unauthenticated URL that distinguishes "no such feed" from "not yours" is a way to test tokens
      for existence.
    */
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Named so a downloaded copy is recognisable, but calendar clients read it in place.
      "Content-Disposition": 'inline; filename="aies.ics"',
      // Never cached by anything in between: a stale schedule is worse than a slow one, and this is
      // per-person data that must not sit in a shared cache.
      "Cache-Control": "no-store, private",
    },
  });
}
