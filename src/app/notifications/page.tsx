"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { PageHeader } from "@/components/ui/layout";
import { TASK_ENTITY_HREF } from "@/server/core/collab/task-rules";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

/**
 * Where a notification's `entityType`/`entityId` actually goes — not exhaustive over every kind of
 * notification the app sends, the same restraint `CALENDAR_ENTITY_HREF` already takes: an entityType
 * not listed here still renders as plain, unlinked text rather than a broken link, so nothing here
 * can point somewhere that does not exist. `SiteInspection` was added 2026-09-04 at the company's own
 * instruction: "when the assigned user... click the site inspection request in the notification,
 * this should direct him to the site inspection request ticket" — before this, nothing on this
 * screen was a link at all.
 */
const NOTIFICATION_ENTITY_HREF: Record<string, (id: string) => string> = {
  ...TASK_ENTITY_HREF,
  SiteInspection: (id) => `/inspections/${id}`,
  Channel: (id) => `/channels/${id}`,
};

/** The destination for the top bar's bell. Reads the notify service built in session 4. */
export default function NotificationsPage() {
  const utils = trpc.useUtils();
  const list = trpc.notify.list.useQuery({});

  const invalidate = () => {
    void utils.notify.list.invalidate();
    void utils.notify.unreadCount.invalidate();
  };
  const markRead = trpc.notify.markRead.useMutation({ onSuccess: invalidate });
  const markAllRead = trpc.notify.markAllRead.useMutation({ onSuccess: invalidate });

  const items = list.data ?? [];
  const hasUnread = items.some((n) => !n.readAt);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        actions={
          hasUnread ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              Mark all read
            </Button>
          ) : null
        }
      />

      {list.isPending && <p className="text-text-muted">Loading...</p>}
      {!list.isPending && items.length === 0 && (
        <p className="rounded-md border border-border bg-surface p-8 text-center text-text-muted">
          Nothing yet.
        </p>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface">
        {items.map((n) => {
          const href = n.entityType ? NOTIFICATION_ENTITY_HREF[n.entityType] : undefined;
          const target = href && n.entityId ? href(n.entityId) : null;

          const body = (
            <>
              <p className="text-sm font-medium">
                {n.title}
                {/* Coalesced notifications carry a count rather than repeating themselves
                    (specs §7.3: "Ten comments on one quote in five minutes is one
                    notification"). */}
                {n.count > 1 && <span className="ml-1 text-text-muted">×{n.count}</span>}
              </p>
              {n.body && <p className="mt-0.5 text-sm text-text-muted">{n.body}</p>}
              <p className="mt-1 text-xs text-text-muted">
                <DateCell value={n.createdAt} withTime />
              </p>
            </>
          );

          return (
            <li
              key={n.id}
              className={cn("flex items-start gap-3 p-3", !n.readAt && "bg-surface-2")}
            >
              {!n.readAt && (
                <span
                  aria-label="Unread"
                  className="mt-1.5 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: "var(--color-blue-600)" }}
                />
              )}
              {target ? (
                <Link
                  href={target}
                  className={cn("min-w-0 flex-1 hover:underline", n.readAt && "pl-5")}
                  onClick={() => {
                    if (!n.readAt) markRead.mutate({ notificationId: n.id });
                  }}
                >
                  {body}
                </Link>
              ) : (
                <div className={cn("min-w-0 flex-1", n.readAt && "pl-5")}>{body}</div>
              )}
              {!n.readAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => markRead.mutate({ notificationId: n.id })}
                >
                  Mark read
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-sm text-text-muted">
        <Link href="/" className="text-blue-600 hover:underline">
          Back to home
        </Link>
      </p>
    </div>
  );
}
