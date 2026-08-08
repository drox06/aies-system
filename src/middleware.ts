import { NextResponse } from "next/server";
import { auth } from "@/auth";

// The session callback (src/auth.ts) re-resolves roles/permissions from Postgres on every
// request rather than trusting JWT claims, so middleware needs a real Prisma lookup — which the
// Edge runtime can't do. Next.js 15.5 stabilized the Node.js middleware runtime for exactly this
// case — see src/auth.config.ts for the alternative if this ever needs to move back to Edge.
export const runtime = "nodejs";

// API routes handle their own auth (Auth.js's own routes, and tRPC's protectedProcedure —
// specs/00-foundation.md §4.2) and must get JSON errors, not HTML redirects.
const PUBLIC_PAGE_PATHS = ["/login"];

function buildCsp(nonce: string): string {
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
      : `'self' 'nonce-${nonce}' 'unsafe-eval'`; // dev-mode Fast Refresh needs eval

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const isApiRoute = pathname.startsWith("/api/");
  let response: NextResponse;

  // `req.auth` can be a truthy session shell with an empty user (deactivated/deleted account —
  // see the `session` callback in src/auth.ts), so check the id, not just session presence.
  const user = req.auth?.user?.id ? req.auth.user : null;

  if (isApiRoute) {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else if (!user) {
    if (PUBLIC_PAGE_PATHS.includes(pathname)) {
      response = NextResponse.next({ request: { headers: requestHeaders } });
    } else {
      const loginUrl = new URL("/login", req.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname);
      response = NextResponse.redirect(loginUrl);
    }
  } else {
    // Signed in. TOTP enrollment is forced before anything else (specs/00-foundation.md §4.1:
    // "the account is unusable until it completes"), then a forced password change if flagged.
    if (!user.totpEnabled && pathname !== "/enroll-totp") {
      response = NextResponse.redirect(new URL("/enroll-totp", req.nextUrl.origin));
    } else if (
      user.mustChangePassword &&
      pathname !== "/change-password" &&
      pathname !== "/enroll-totp"
    ) {
      response = NextResponse.redirect(new URL("/change-password", req.nextUrl.origin));
    } else if (PUBLIC_PAGE_PATHS.includes(pathname)) {
      response = NextResponse.redirect(new URL("/", req.nextUrl.origin));
    } else {
      response = NextResponse.next({ request: { headers: requestHeaders } });
    }
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  return response;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"],
};
