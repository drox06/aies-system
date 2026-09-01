import { redirect } from "next/navigation";

/**
 * Principals moved in with Suppliers on one screen (2026-09-01, the company's own instruction) —
 * see `/suppliers/page.tsx`. This route stays only so a bookmark or an old link does not 404.
 */
export default function PrincipalsRedirectPage() {
  redirect("/suppliers");
}
