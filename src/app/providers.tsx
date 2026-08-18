"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { AppShell } from "@/components/shell/AppShell";
import { ServiceWorker } from "@/components/shell/ServiceWorker";
import { GlobalSearch } from "@/components/GlobalSearch";
import { TrpcProvider } from "@/lib/trpc/provider";

/**
 * Routes that deliberately render without the shell, for two different reasons.
 *
 * The first three are states where the user is not yet fully signed in, so a sidebar full of links
 * they cannot follow — and a nav query that would 401 — is exactly wrong.
 *
 * `/field` is the other reason: specs/04-operations-projects.md §14 asks for "a distinct,
 * stripped-down screen for drivers: today's drops, navigate, log attempt, capture signature.
 * **Nothing else.**" A hamburger, a search box, a notification bell and a help button are four more
 * things to mis-tap while holding a box in sunlight. The screen was written shell-free and the shell
 * was wrapping it anyway — visible the moment anybody looked at it on a phone, and invisible to
 * every test until then.
 */
const BARE_ROUTES = ["/login", "/enroll-totp", "/change-password", "/field"];

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
        {/* Mounted outside <Chrome> so errors on the login and TOTP screens are reported too. */}
        <Toaster position="bottom-right" richColors closeButton />
        <ServiceWorker />
      </TrpcProvider>
    </SessionProvider>
  );
}
