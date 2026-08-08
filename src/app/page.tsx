"use client";

import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

export default function Home() {
  const whoami = trpc.system.whoami.useQuery();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={whoami.data ? `Welcome, ${whoami.data.name}` : "AIES Operations Platform"}
        description="Module 00 — Foundation. Business modules land from module 01 onward."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-base">Your access</h2>
          {whoami.data ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
              <dt className="text-text-muted">Email</dt>
              <dd className="truncate">{whoami.data.email}</dd>
              <dt className="text-text-muted">Roles</dt>
              <dd>{whoami.data.roleKeys.join(", ") || "none"}</dd>
              <dt className="text-text-muted">Permissions</dt>
              <dd>{whoami.data.permissions.length}</dd>
            </dl>
          ) : (
            <p className="text-sm text-text-muted">Loading...</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-base">Foundation services</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {[
              "Auth, TOTP, RBAC",
              "Audit log, events, jobs",
              "Storage, notify, approvals",
              "Comments, search, numbering",
              "Design system, app shell",
            ].map((label) => (
              <li key={label} className="flex items-center justify-between gap-2">
                <span>{label}</span>
                <StatusBadge tone="approved">Built</StatusBadge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {whoami.data?.permissions.includes("admin.manage_users") && (
        <p className="mt-4 text-sm">
          <Link href="/admin/users" className="text-blue-600 hover:underline">
            Manage users →
          </Link>
        </p>
      )}
    </div>
  );
}
