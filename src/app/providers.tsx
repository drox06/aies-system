"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { GlobalSearch } from "@/components/GlobalSearch";
import { TrpcProvider } from "@/lib/trpc/provider";

/**
 * Routes that deliberately render without the shell. All three are states where the user is not
 * yet fully signed in, so a sidebar full of links they cannot follow — and a nav query that would
 * 401 — is exactly wrong.
 */
const BARE_ROUTES = ["/login", "/enroll-totp", "/change-password"];

function Chrome({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();

  const bare = BARE_ROUTES.some((r) => pathname.startsWith(r));
  if (bare || status !== "authenticated") return <>{children}</>;

  return (
    <>
      <AppShell>{children}</AppShell>
      <GlobalSearch />
    </>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TrpcProvider>
        <Chrome>{children}</Chrome>
      </TrpcProvider>
    </SessionProvider>
  );
}
