"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { offlineSupported, storageStanding, type OutboxItem } from "./db";
import { drainOutbox, listQueue, queueSummary } from "./outbox";

/**
 * specs/04-operations-projects.md §14's sync engine, as a hook.
 *
 * §14 asks for a "persistent sync-status indicator with queue count and a manual 'sync now'". The
 * word doing the work there is **persistent**: a technician has to be able to glance at the screen
 * and know whether their afternoon is safely on the server or still in their hand. A spinner that
 * appears during a sync and vanishes afterwards answers the wrong question.
 *
 * ## When it syncs
 *
 * On mount, whenever the browser says it is back online, and on a slow interval while there is
 * something queued. Not on a fast timer: a phone in a plant has no signal and a tight retry loop
 * costs battery, which is the resource a technician actually runs out of on a long day.
 *
 * `navigator.onLine` is treated as a hint, never as truth. It reports whether there is a network
 * interface, not whether anything is reachable — a plant's wifi with no route out is "online" by
 * that measure. So a drain is attempted regardless and failure is the real signal.
 */

export type SendItem = (item: OutboxItem) => Promise<{ rejected?: boolean; reason?: string }>;

/** Slow on purpose: battery is the resource that runs out on a long day in the field. */
const RETRY_INTERVAL_MS = 60_000;

export interface SyncState {
  supported: boolean;
  queued: number;
  failed: number;
  rejected: number;
  oldestCapturedAt: number | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  storageWarn: boolean;
  storagePct: number;
  items: OutboxItem[];
}

const EMPTY: SyncState = {
  supported: false,
  queued: 0,
  failed: 0,
  rejected: 0,
  oldestCapturedAt: null,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  storageWarn: false,
  storagePct: 0,
  items: [],
};

export function useSync(send: SendItem) {
  const [state, setState] = useState<SyncState>(EMPTY);
  // Held in a ref so a re-render mid-drain cannot start a second one. Two concurrent drains would
  // send the same item twice — harmless on the server thanks to the UUID, but it would double-count
  // attempts and make the queue's own numbers lie.
  const draining = useRef(false);
  const sendRef = useRef(send);
  sendRef.current = send;

  const refresh = useCallback(async () => {
    if (!offlineSupported()) return;
    const [summary, items, storage] = await Promise.all([
      queueSummary(),
      listQueue(),
      storageStanding(),
    ]);
    setState((prev) => ({
      ...prev,
      supported: true,
      queued: summary.queued,
      failed: summary.failed,
      rejected: summary.rejected,
      oldestCapturedAt: summary.oldestCapturedAt,
      items,
      storageWarn: storage.warn,
      storagePct: storage.pct,
    }));
  }, []);

  const sync = useCallback(async () => {
    if (!offlineSupported() || draining.current) return;
    draining.current = true;
    setState((prev) => ({ ...prev, syncing: true }));

    try {
      const result = await drainOutbox((item) => sendRef.current(item));
      setState((prev) => ({
        ...prev,
        lastSyncAt: Date.now(),
        // An interrupted drain is not an error to shout about — being out of signal is the normal
        // condition this whole section exists for. The queue count already says work is waiting.
        lastError: result.interrupted ? "Still waiting for a connection." : null,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        lastError: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      draining.current = false;
      setState((prev) => ({ ...prev, syncing: false }));
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!offlineSupported()) {
      setState((prev) => ({ ...prev, supported: false }));
      return;
    }

    void refresh().then(() => void sync());

    const onOnline = () => void sync();
    window.addEventListener("online", onOnline);

    const timer = window.setInterval(() => {
      void queueSummary().then((summary) => {
        if (summary.queued > 0 || summary.failed > 0) void sync();
      });
    }, RETRY_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
    };
  }, [refresh, sync]);

  return { ...state, sync, refresh };
}

/** "4 hours ago", for the oldest item in the queue. */
export function describeAge(at: number | null): string | null {
  if (!at) return null;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
