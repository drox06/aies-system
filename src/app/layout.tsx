import type { Metadata } from "next";
import { TrpcProvider } from "@/lib/trpc/provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIES Operations Platform",
  description: "Internal ERP/CRM/collaboration platform for AIES Electromechanical Corporation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TrpcProvider>{children}</TrpcProvider>
      </body>
    </html>
  );
}
