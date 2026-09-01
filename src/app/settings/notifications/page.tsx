"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Label, Select } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { pushSupported, subscribeThisDevice, unsubscribeIfThisDevice } from "@/lib/push";
import { trpc } from "@/lib/trpc/client";
import {
  TYPE_LEVEL_LABELS,
  TYPE_NOTIFICATION_LEVELS,
  formatMinutes,
  type TypeNotificationLevel,
} from "@/server/core/collab/quiet-hours-rules";

/**
 * §7's notification settings.
 *
 * ## Why quiet hours hold rather than drop
 *
 * §7 gives the reason for the window and, read carefully, the reason it cannot simply discard:
 * *"a system that pings technicians at midnight gets muted, and then the important message is missed
 * too."* A notification thrown away at 23:00 produces the same missed message, only silently. So it
 * is written, hidden until morning, and released — and this screen says how many are waiting, which
 * is the proof that nothing was lost.
 *
 * ## What passes anyway
 *
 * A short list, marked on each row. Every addition to it is a promise that the thing is genuinely
 * worth waking somebody for, and a list that grows is how the phone ends up face-down.
 */

const HOURS = Array.from({ length: 24 }, (_, hour) => hour * 60);

export default function NotificationSettingsPage() {
  const utils = trpc.useUtils();
  const settings = trpc.collab.notificationSettings.useQuery();

  const setLevel = trpc.collab.setNotificationLevel.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      void utils.collab.notificationSettings.invalidate();
    },
    onError: toastError,
  });

  const setQuiet = trpc.collab.setQuietHours.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      void utils.collab.notificationSettings.invalidate();
    },
    onError: toastError,
  });

  const [draft, setDraft] = useState<{
    quietHoursOn: boolean;
    quietFromMinutes: number;
    quietToMinutes: number;
    digestAtMinutes: number;
  } | null>(null);

  const quiet = draft ?? settings.data?.quietHours ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="What you are told about"
        description="Which messages reach you, and when they are allowed to."
      />

      {settings.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      <DevicesCard />

      {quiet && (
        <Card className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">Quiet hours</h2>
            {settings.data?.usingDefaults && <StatusBadge tone="draft">Default</StatusBadge>}
            {(settings.data?.held ?? 0) > 0 && (
              <StatusBadge tone="info">{settings.data!.held} waiting for morning</StatusBadge>
            )}
          </div>

          <p className="text-sm text-text-muted">
            Between {formatMinutes(quiet.quietFromMinutes)} and{" "}
            {formatMinutes(quiet.quietToMinutes)} nothing reaches you — it is{" "}
            <strong className="text-text">held, not dropped</strong>, and arrives at{" "}
            {formatMinutes(quiet.digestAtMinutes)}. Urgent work and emergency tickets come through
            at any hour.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={quiet.quietHoursOn}
              onChange={(event) => setDraft({ ...quiet, quietHoursOn: event.target.checked })}
            />
            Hold messages overnight
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="quiet-from">From</Label>
              <Select
                id="quiet-from"
                value={quiet.quietFromMinutes}
                disabled={!quiet.quietHoursOn}
                onChange={(event) =>
                  setDraft({ ...quiet, quietFromMinutes: Number(event.target.value) })
                }
              >
                {HOURS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatMinutes(minutes)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="quiet-to">Until</Label>
              <Select
                id="quiet-to"
                value={quiet.quietToMinutes}
                disabled={!quiet.quietHoursOn}
                onChange={(event) =>
                  setDraft({ ...quiet, quietToMinutes: Number(event.target.value) })
                }
              >
                {HOURS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatMinutes(minutes)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="digest-at">Held messages arrive at</Label>
              <Select
                id="digest-at"
                value={quiet.digestAtMinutes}
                onChange={(event) =>
                  setDraft({ ...quiet, digestAtMinutes: Number(event.target.value) })
                }
              >
                {HOURS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatMinutes(minutes)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Button
              disabled={setQuiet.isPending || !draft}
              onClick={() => {
                if (draft) setQuiet.mutate(draft);
                setDraft(null);
              }}
            >
              Save
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-medium">Each kind of message</h2>
        <p className="mt-1 text-xs text-text-muted">
          &ldquo;Only in the daily digest&rdquo; still reaches you — once, in the morning, instead
          of each time.
        </p>

        <ul className="mt-3 flex flex-col gap-3">
          {(settings.data?.types ?? []).map((type) => (
            <li key={type.key} className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{type.label}</p>
                {type.alwaysThrough && (
                  <p className="text-xs text-text-muted">
                    Reaches you at any hour, quiet hours included.
                  </p>
                )}
              </div>
              <Select
                aria-label={type.label}
                className="h-9 w-64 text-sm"
                value={type.level}
                disabled={setLevel.isPending}
                onChange={(event) =>
                  setLevel.mutate({
                    type: type.key,
                    level: event.target.value as TypeNotificationLevel,
                  })
                }
              >
                {TYPE_NOTIFICATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {TYPE_LEVEL_LABELS[level]}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      </Card>

      <p className="mt-3 text-xs text-text-muted">
        Email is not sent by this platform yet — everything arrives in the bell. The setting is kept
        so it means the same thing when email is wired.
      </p>
    </div>
  );
}

/**
 * §7's actual device alert, on top of the in-app bell above. Its own card because it is a
 * per-device decision — a phone and a desktop are enabled separately, each with their own
 * "Remove" — not a single on/off switch the way the settings above are.
 */
function DevicesCard() {
  const utils = trpc.useUtils();
  const publicKey = trpc.notify.pushPublicKey.useQuery();
  const devices = trpc.notify.listDevices.useQuery();

  const subscribe = trpc.notify.subscribeDevice.useMutation({
    onSuccess: () => {
      toastSuccess("This device will now receive notifications directly.");
      void utils.notify.listDevices.invalidate();
    },
    onError: toastError,
  });
  const unsubscribe = trpc.notify.unsubscribeDevice.useMutation({
    onSuccess: () => {
      toastSuccess("Removed.");
      void utils.notify.listDevices.invalidate();
    },
    onError: toastError,
  });

  const [enabling, setEnabling] = useState(false);

  async function enable() {
    if (!publicKey.data?.key) return;
    setEnabling(true);
    try {
      const device = await subscribeThisDevice(publicKey.data.key);
      await subscribe.mutateAsync(device);
    } catch (error) {
      toastError(error);
    } finally {
      setEnabling(false);
    }
  }

  const rows = devices.data ?? [];
  const supported = pushSupported();

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <h2 className="text-sm font-medium">This device</h2>
      <p className="text-sm text-text-muted">
        The bell above only shows something when the app is open. Enabling this makes the device
        itself alert you — the phone, not just the screen. Urgent work reaches it at any hour;
        everything else follows the quiet hours below.
      </p>

      {!publicKey.isLoading && !publicKey.data?.key && (
        <p className="text-sm text-warning">
          Not set up on this deployment yet — an operator needs to add the push keys before this can
          work.
        </p>
      )}

      {!supported && (
        <p className="text-sm text-text-muted">
          This browser does not support device notifications. On an iPhone, this only works once the
          app has been added to the Home Screen (Share → Add to Home Screen) — a bookmark or an open
          tab in Safari cannot be enabled.
        </p>
      )}

      {supported && publicKey.data?.key && (
        <div>
          <Button disabled={enabling || subscribe.isPending} onClick={() => void enable()}>
            {enabling || subscribe.isPending ? "Enabling…" : "Enable notifications on this device"}
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-1 divide-y divide-border">
          {rows.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {device.userAgent ?? "Unknown device"}
              </span>
              <span className="text-xs text-text-muted">
                added <DateCell value={device.createdAt} />
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                disabled={unsubscribe.isPending}
                onClick={async () => {
                  await unsubscribeIfThisDevice(device.endpoint).catch(() => {});
                  unsubscribe.mutate({ endpoint: device.endpoint });
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
