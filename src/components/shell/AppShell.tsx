"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  BadgeCheck,
  Building2,
  ClipboardCheck,
  ShieldCheck,
  FolderKanban,
  Columns3,
  FileText,
  Handshake,
  Inbox,
  Sunrise,
  Users,
  type LucideIcon,
  CircleCheck,
  ClipboardList,
  Package,
  Truck,
  Wallet,
  Wrench,
  Receipt,
  Phone,
  Banknote,
  ListChecks,
  MessageSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { BackButton } from "@/components/shell/BackButton";
import { Logo } from "@/components/brand/Logo";
import { isNavIconName, type NavIconName } from "@/components/shell/nav-icons";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/ui/cells";
import { Menu, MenuItem } from "@/components/ui/menu";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

/**
 * The application shell: persistent left sidebar, top bar, content area (Spec.md §6.6).
 *
 * Nav comes from `system.nav`, which assembles it from module manifests and filters it by
 * permission server-side — this component never decides who may see what.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const nav = trpc.system.nav.useQuery();
  const whoami = trpc.system.whoami.useQuery();
  const unread = trpc.notify.unreadCount.useQuery(undefined, {
    // The bell should go stale in seconds, not minutes, but polling every page for five users is
    // not worth a websocket yet. Supabase Realtime is the upgrade path (specs §7.3).
    refetchInterval: 60_000,
  });

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer on navigation, or it stays over the page the user just chose.
  useEffect(() => setMobileOpen(false), [pathname]);

  const groups = groupNav(nav.data ?? []);

  /**
   * Which groups are folded, remembered per browser.
   *
   * `false` means closed; anything else means open, so a group nobody has touched starts open — a
   * sidebar that hides everything on first load is worse than one that shows too much.
   */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const stored = window.localStorage.getItem("nav:groups");
    if (stored) {
      try {
        setOpenGroups(JSON.parse(stored) as Record<string, boolean>);
      } catch {
        // A corrupted preference is not worth a crash: fall back to everything open.
      }
    }
  }, []);

  function toggleGroup(group: string) {
    setOpenGroups((current) => {
      const next = { ...current, [group]: current[group] === false };
      window.localStorage.setItem("nav:groups", JSON.stringify(next));
      return next;
    });
  }

  /** The group holding the page you are on. It stays open regardless of what was stored. */
  const activeGroup =
    groups.find(({ entries }) =>
      entries.some((entry) =>
        entry.href === "/" ? pathname === "/" : pathname.startsWith(entry.href),
      ),
    )?.group ?? null;

  const sidebar = (
    <nav
      aria-label="Main"
      className={cn(
        "flex h-full flex-col bg-navy-800 text-text-invert transition-[width] duration-150",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* The full-colour lockup on a white plate rather than the mono-white silhouette.
          Spec.md §6.1 forbids the gradient version on a *coloured* background — the wordmark's
          "AI" is navy-900→blue-600 and would vanish into navy — so the plate is what makes this
          legal as well as legible: the logo sits on white, and the white sits on navy. The
          padding is the clear space §6.1 asks for. */}
      <div
        className={cn(
          "flex shrink-0 items-center border-b border-white/10",
          collapsed ? "h-20 justify-center px-2" : "h-28 px-3",
        )}
      >
        <Link
          href="/"
          aria-label="AIES home"
          className={cn(
            "flex w-full items-center justify-center rounded-md bg-surface",
            collapsed ? "p-1.5" : "p-2",
          )}
        >
          {collapsed ? (
            <Logo variant="mark" height={34} />
          ) : (
            // w-full + h-auto scales it to the sidebar rather than a fixed pixel height, so it
            // stays edge-to-edge if the sidebar width ever changes.
            <Logo variant="primary" height={128} className="h-auto w-full" />
          )}
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {groups.map(({ group, entries }) => {
          /*
            A group folds away, and remembers.

            Five headings — Sales, Customers, Orders, Operations, Admin — with thirty-odd entries
            under them, and nobody works across all five in a day. Sales does not open the store;
            operations does not raise quotations. Folding the ones you never touch is the difference
            between a sidebar you scan and a sidebar you search.

            **The group holding the current page always opens**, whatever was stored. Coming back to
            a screen and finding its own menu heading collapsed reads as the app having lost your
            place, and the fix — expanding a group to see the page already in front of you — is
            pointless work.

            Ungrouped entries have no heading to click, so they never fold.
          */
          const open = group === null || openGroups[group] !== false || activeGroup === group;

          return (
            <div key={group ?? "_"} className="mb-3">
              {group && !collapsed && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1.5 px-4 pb-1 text-left text-xs font-medium tracking-wide text-white/45 uppercase hover:text-white/80"
                >
                  <span aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`}>
                    ›
                  </span>
                  {group}
                </button>
              )}
              {(open || collapsed) &&
                entries.map((entry) => {
                  const active =
                    entry.href === "/" ? pathname === "/" : pathname.startsWith(entry.href);
                  return (
                    <Link
                      key={entry.href}
                      href={entry.href}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? entry.label : undefined}
                      className={cn(
                        "flex items-center gap-3 py-2.5 pr-3 pl-4 text-sm transition-colors",
                        // Spec.md §6.4: active nav marked with a 3px red-500 left bar — "the one place
                        // brand red earns its keep in the chrome". Inactive items reserve the same 3px
                        // with a transparent border so labels do not shift on selection.
                        active
                          ? "border-l-[3px] border-red-500 bg-white/10 pl-[13px] font-medium"
                          : "border-l-[3px] border-transparent pl-[13px] text-white/75 hover:bg-white/5 hover:text-white",
                      )}
                    >
                      {(() => {
                        // Narrowed rather than indexed by a bare string: the map is now typed by
                        // the name list, so an icon a manifest invented cannot silently resolve to
                        // undefined and render the placeholder. See nav-icons.ts.
                        const Icon =
                          entry.icon && isNavIconName(entry.icon) ? ICONS[entry.icon] : null;
                        return Icon ? (
                          <Icon
                            aria-hidden
                            size={ICON_SIZE}
                            strokeWidth={2.25}
                            className="shrink-0"
                          />
                        ) : (
                          // A module with an unmapped icon still gets an aligned placeholder rather
                          // than a ragged row.
                          <span
                            aria-hidden
                            className="flex shrink-0 items-center justify-center"
                            style={{ width: ICON_SIZE, height: ICON_SIZE }}
                          >
                            <span className="size-1.5 rounded-full bg-current opacity-60" />
                          </span>
                        );
                      })()}
                      {!collapsed && <span className="truncate">{entry.label}</span>}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </div>

      {/* Which build this is. Seven characters that answer "has my fix deployed yet?" */}
      {!collapsed && (
        <p className="shrink-0 border-t border-white/10 px-4 py-1.5 text-[11px] text-white/35">
          build {process.env.NEXT_PUBLIC_BUILD_COMMIT}
        </p>
      )}

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="hidden h-10 shrink-0 items-center gap-3 border-t border-white/10 pl-4 text-sm text-white/60 hover:text-white md:flex"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <span aria-hidden className="w-4 text-center">
          {collapsed ? "»" : "«"}
        </span>
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className="hidden md:block">{sidebar}</div>

      {/* Mobile drawer. Spec.md §6.6: field views are used one-handed, so it opens from the left
          and covers the page rather than squeezing it. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-navy-900/50"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-60">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </Button>

          {/* Only renders in the installed app, which has no browser back button of its own. */}
          <BackButton />

          {/* The search field is a button: the actual search UI is the Cmd/Ctrl+K palette from
              session 4, and having two search entry points that behave differently is worse than
              one that advertises its shortcut. */}
          <button
            type="button"
            onClick={() => {
              document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
              );
            }}
            className="flex h-8 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-bg px-3 text-sm text-text-muted hover:bg-surface-2"
          >
            <span aria-hidden>⌕</span>
            <span>Search</span>
            <kbd className="ml-auto hidden rounded border border-border px-1 text-xs sm:inline">
              Ctrl K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/notifications"
              className="relative inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2"
              aria-label={unread.data ? `Notifications (${unread.data} unread)` : "Notifications"}
            >
              <span aria-hidden>🔔</span>
              {typeof unread.data === "number" && unread.data > 0 && (
                <span
                  className="absolute top-1 right-1 min-w-4 rounded-full px-1 text-[10px] leading-4 font-medium text-text-invert"
                  style={{ backgroundColor: "var(--color-danger)" }}
                >
                  {unread.data > 99 ? "99+" : unread.data}
                </span>
              )}
            </Link>

            <Menu
              label="Account menu"
              triggerClassName="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2"
              trigger={<UserAvatar name={whoami.data?.name ?? "?"} size={26} />}
            >
              <div className="border-b border-border px-3 py-2">
                <p className="truncate text-sm font-medium">{whoami.data?.name}</p>
                <p className="truncate text-xs text-text-muted">{whoami.data?.email}</p>
                <p className="mt-1 truncate text-xs text-text-muted">
                  {whoami.data?.roleKeys.join(", ") || "no roles"}
                </p>
              </div>
              <MenuItem onClick={() => void signOut({ callbackUrl: "/login" })}>Sign out</MenuItem>
            </Menu>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4">{children}</main>
      </div>
    </div>
  );
}

/**
 * Manifests declare icons as plain strings (`icon: "home"`), so the string→component mapping lives
 * here — one reviewable place, and a module cannot pull an arbitrary icon into the shell.
 *
 * Sized at 20px against 14px label text. That ratio is the point of the sizing: large enough to
 * scan the sidebar by shape rather than by reading it, small enough that the label still leads.
 * `strokeWidth` is lifted to 2.25 because these sit on navy — a 2px stroke that reads fine on
 * white goes thin and grey against a dark ground.
 */
const ICONS: Record<NavIconName, LucideIcon> = {
  check: ClipboardCheck,
  users: Users,
  // Module 01 (specs/01-crm-inquiry.md).
  sun: Sunrise,
  columns: Columns3,
  building: Building2,
  inbox: Inbox,
  "badge-check": BadgeCheck,
  handshake: Handshake,
  "file-text": FileText,
  // Module 02 (specs/02-quotation.md).
  "check-circle": CircleCheck,
  // Module 03 (specs/03-order-procurement.md). `truck` shipped unmapped with the supplier nav entry
  // in session 1 and rendered the placeholder — the fallback is deliberately quiet, which is
  // exactly why an unmapped icon can survive a review.
  truck: Truck,
  "clipboard-list": ClipboardList,
  package: Package,
  // Module 04 (specs/04-operations-projects.md).
  wrench: Wrench,
  wallet: Wallet,
  "clipboard-check": ClipboardCheck,
  "shield-check": ShieldCheck,
  "folder-kanban": FolderKanban,
  // Module 05 (specs/05-finance-billing.md). Both shipped unmapped and rendered the placeholder
  // dot — the third and fourth instances of the fault the `truck` comment above warns about, which
  // is why the names now live in nav-icons.ts and the type here is no longer `string`.
  receipt: Receipt,
  phone: Phone,
  banknote: Banknote,
  // Module 06 (specs/06-collaboration.md).
  "list-checks": ListChecks,
  "message-square": MessageSquare,
};

const ICON_SIZE = 20;

interface NavEntry {
  label: string;
  href: string;
  icon: string | null;
  group: string | null;
}

/** Ungrouped entries first, then named groups in first-seen order — which, because the registry
 *  already sorted by `order`, is the order modules asked for. */
function groupNav(entries: NavEntry[]): { group: string | null; entries: NavEntry[] }[] {
  const out: { group: string | null; entries: NavEntry[] }[] = [];
  for (const entry of entries) {
    const existing = out.find((g) => g.group === entry.group);
    if (existing) existing.entries.push(entry);
    else out.push({ group: entry.group, entries: [entry] });
  }
  return out.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0));
}
