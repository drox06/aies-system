import type { Metadata } from "next";
import { headers } from "next/headers";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIES Operations Platform",
  description: "Internal ERP/CRM/collaboration platform for AIES Electromechanical Corporation",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce here (set by middleware.ts) is what makes Next.js stamp its own
  // framework-injected scripts with it — without this, the strict production CSP's
  // 'strict-dynamic' has no matching nonce on any script tag and silently blocks all hydration.
  await headers();

  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
