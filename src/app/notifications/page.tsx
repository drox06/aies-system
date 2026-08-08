"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { PageHeader } from "@/components/ui/layout";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

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
        {items.map((n) => (
          <li key={n.id} className={cn("flex items-start gap-3 p-3", !n.readAt && "bg-surface-2")}>
            {!n.readAt && (
              <span
                aria-label="Unread"
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: "var(--color-blue-600)" }}
              />
            )}
            <div className={cn("min-w-0 flex-1", n.readAt && "pl-5")}>
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
            </div>
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
        ))}
      </ul>

      <p className="mt-4 text-sm text-text-muted">
        <Link href="/" className="text-blue-600 hover:underline">
          Back to home
        </Link>
      </p>
    </div>
  );
}
