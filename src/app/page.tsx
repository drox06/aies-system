"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";

export default function Home() {
  const whoami = trpc.system.whoami.useQuery();

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>AIES Operations Platform</h1>
      <p>Module 00 — Foundation is under construction.</p>

      {whoami.data && (
        <div style={{ margin: "1.5rem 0" }}>
          <p>
            Signed in as <strong>{whoami.data.name}</strong> ({whoami.data.email})
          </p>
          <p>Roles: {whoami.data.roleKeys.join(", ") || "none"}</p>
          {whoami.data.permissions.includes("admin.manage_users") && (
            <p>
              <Link href="/admin/users">Manage users</Link>
            </p>
          )}
        </div>
      )}

      <button onClick={() => void signOut({ callbackUrl: "/login" })}>Sign out</button>
    </main>
  );
}
