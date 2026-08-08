"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { GlobalSearch } from "@/components/GlobalSearch";
import { TrpcProvider } from "@/lib/trpc/provider";

function AuthedGlobalSearch() {
  const { status } = useSession();
  if (status !== "authenticated") return null;
  return <GlobalSearch />;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TrpcProvider>
        {children}
        <AuthedGlobalSearch />
      </TrpcProvider>
    </SessionProvider>
  );
}
