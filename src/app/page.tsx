"use client";

import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { trpc } from "@/lib/trpc/client";

/**
 * Home.
 *
 * Was a module 00 scaffold until 2026-08-17 — it told the signed-in user their own permission count
 * and listed the infrastructure that had been built. The first screen everybody opens every day, about
 * the software rather than about their work.
 *
 * Now it answers one question: **what needs you?** Across every module, filtered to what this person
 * can actually act on. See home-service.ts for why this is not a redirect to My day: My day is
 * CRM-only, so half the company would land on a page about somebody else's job.
 */
export default function Home() {
  const home = trpc.system.home.useQuery();
  const whoami = trpc.system.whoami.useQuery();

  const waiting = (home.data?.tiles ?? []).filter((tile) => tile.count > 0);
  const clear = (home.data?.tiles ?? []).filter((tile) => tile.count === 0);

  return (
    <div>
      <PageHeader
        title={whoami.data?.name ? `Good day, ${whoami.data.name}` : "Home"}
        description="What needs you, across everything you can reach."
      />

      {home.isPending && <p className="text-sm text-text-muted">Loading…</p>}
      {home.error && <p className="text-sm text-danger">{home.error.message}</p>}

      {/*
        Zero is stated rather than hidden. An empty page and a page saying "nothing waiting" are the
        same pixels and completely different messages — one reads as being up to date, the other as
        broken. Same distinction the gates and waivers make everywhere else in this platform.
      */}
      {home.data?.allClear && (
        <EmptyState
          title="Nothing is waiting on you"
          description="Every queue you can reach is clear."
        />
      )}

      {waiting.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {waiting.map((tile) => (
            <Link key={tile.key} href={tile.href} className="block">
              <Card className="h-full p-4 transition-colors hover:border-brand">
                <p className="tabular text-2xl font-semibold">{tile.count}</p>
                <p className="mt-0.5 text-sm font-medium">{tile.label}</p>
                <p className="mt-0.5 text-xs text-text-muted">{tile.detail}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {clear.length > 0 && !home.data?.allClear && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold">Clear</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {clear.map((tile) => (
              <li key={tile.key} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={tile.href} className="hover:underline">
                  {tile.label}
                </Link>
                <span className="text-xs text-text-muted">{tile.clear}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        {/* My day is the sales-side detail this page deliberately does not reproduce. */}
        <Link href="/crm/my-day" className="underline">
          My day — follow-ups, silent quotations, your surveys
        </Link>
        {(whoami.data?.permissions ?? []).includes("admin.manage_users") && (
          <Link href="/admin/users" className="underline">
            Manage users
          </Link>
        )}
      </div>
    </div>
  );
}
