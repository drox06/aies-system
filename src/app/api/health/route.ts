import { NextResponse } from "next/server";

/**
 * Is it up, and **what is it running**?
 *
 * The second half is the part that was missing, and it cost real time on 2026-08-19: after pushing a
 * batch of work there was no way to tell whether Vercel had actually shipped it. The site answered,
 * the login page rendered, and the only place the build sha appeared was the sidebar — behind the
 * login, on a platform with mandatory TOTP. "It looks fine" is not deployment verification.
 *
 * That is not a hypothetical worry here. Between `ea3d725` and `7ca06e5` nothing deployed at all:
 * Vercel's cached Prisma Client predated the new models, every build failed on a type error, and the
 * live site quietly stayed several commits behind while serving perfectly well. A phone pass was
 * carried out against the wrong code and had to be repeated. See docs/DEPLOYMENT.md.
 *
 * `commit` comes from `VERCEL_GIT_COMMIT_SHA` through next.config.ts, and reads `dev` when running
 * locally — which is itself the answer to "am I looking at my machine or the deployment?"
 *
 * ## Why this is safe to serve unauthenticated
 *
 * A commit sha of a private repository is not a secret in any useful sense: it identifies a build,
 * it does not describe one. Anything that *is* sensitive — connection strings, the database, who is
 * logged in — is deliberately absent. This endpoint touches nothing and queries nothing, which also
 * means a green answer says the app is serving, **not** that the database is reachable. Anybody
 * tempted to wire an uptime monitor to it should know it cannot fail for the reason they care about.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    commit: process.env.NEXT_PUBLIC_BUILD_COMMIT ?? "unknown",
    time: new Date().toISOString(),
  });
}
