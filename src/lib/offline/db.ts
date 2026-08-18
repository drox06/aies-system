import Dexie, { type Table } from "dexie";

/**
 * specs/04-operations-projects.md §14's offline store.
 *
 * ## What is kept here, and what is deliberately not
 *
 * §14 asks for "the technician's tickets for the next 7 days plus checklists, methodology, site
 * data, equipment history, contact list, and reference documents". That is a read cache, and it is
 * genuinely useful: a plant with no signal is the normal case, not the exception.
 *
 * It is also the dangerous half. `public/sw.js` refuses to cache authenticated HTML for a reason
 * worth restating here, because this file is where somebody will be tempted to undo it: **stale ERP
 * data shown as if current is worse than an honest "you are offline"**, and cached authenticated
 * data survives sign-out on a device that may be handed to somebody else. So every cached row
 * carries `cachedAt`, the UI shows how old it is rather than pretending it is live, and `wipe()` is
 * called on sign-out.
 *
 * ## The outbox is the part that must not lose anything
 *
 * Everything else here can be rebuilt by reconnecting. The outbox cannot — it holds work that exists
 * nowhere else in the world. §14: "never silently drop queued items", and "losing a technician's
 * afternoon destroys trust in the system permanently".
 *
 * That shapes three things:
 *
 *  - An item is deleted **only** once the server has acknowledged it by `clientUuid`. Not on send,
 *    not on a 200 that might have been for something else.
 *  - Failures increment `attempts` and record `lastError`; they never delete. An item that cannot
 *    sync is shown to the technician, not discarded on their behalf.
 *  - Photos are stored as Blobs in the same database, so a queued attempt and its evidence cannot
 *    be separated by one of them being evicted.
 */

/** Bumped when the schema below changes. Dexie runs the upgrade path between versions. */
const SCHEMA_VERSION = 1;

export type OutboxStatus = "queued" | "sending" | "failed" | "rejected";

export interface OutboxItem {
  /** The client-generated UUID the server is idempotent on. Also this table's primary key, so the
   *  same submission can never be enqueued twice by a double tap. */
  clientUuid: string;
  /** Which tRPC mutation this replays into, as a dotted path — `operations.logDeliveryAttempt`. */
  procedure: string;
  operation: string;
  payload: unknown;
  /** When the device recorded it. Distinct from when it is finally sent, which may be hours later. */
  capturedAt: number;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /** Set when the server refused it on a business rule, so the screen can explain rather than retry. */
  rejectionReason: string | null;
  /** Photo/signature blobs belonging to this item, uploaded before the write is replayed. */
  attachmentIds: string[];
  /** A human label for the queue list, so the technician sees "Delivery attempt — AIESDT-2601" and
   *  not a UUID. */
  label: string;
}

export interface OutboxAttachment {
  id: string;
  clientUuid: string;
  blob: Blob;
  filename: string;
  mimeType: string;
  /** Byte size after compression, for the storage guard's arithmetic. */
  size: number;
  /** Set once uploaded, so a retry of the write does not re-upload the photo. */
  serverFileId: string | null;
}

export interface CachedRecord {
  /** `${kind}:${id}` — one table for every kind of cached read, since they share a lifecycle. */
  key: string;
  kind: string;
  id: string;
  data: unknown;
  cachedAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

class OfflineDb extends Dexie {
  outbox!: Table<OutboxItem, string>;
  attachments!: Table<OutboxAttachment, string>;
  cache!: Table<CachedRecord, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super("aies-field");
    this.version(SCHEMA_VERSION).stores({
      outbox: "clientUuid, status, capturedAt",
      attachments: "id, clientUuid",
      cache: "key, kind, cachedAt",
      meta: "key",
    });
  }
}

/**
 * Created lazily and only in a browser.
 *
 * This module is imported by components that render on the server during the Next build, where
 * `indexedDB` does not exist. Constructing Dexie at module scope would throw there, and the failure
 * would present as a build error a long way from its cause.
 */
let instance: OfflineDb | null = null;

export function offlineDb(): OfflineDb {
  if (typeof indexedDB === "undefined") {
    throw new Error("The offline store is browser-only; there is no IndexedDB here.");
  }
  instance ??= new OfflineDb();
  return instance;
}

/** Whether this browser can hold a queue at all. Checked before offering offline features. */
export function offlineSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Clears everything on sign-out.
 *
 * **Refuses while work is queued**, and says so, rather than quietly taking the safer-looking route
 * of wiping. A technician signing out on a shared device with an unsent afternoon in the queue has
 * to be told; deleting it to protect the next user's privacy would be the exact silent discard §14
 * calls a permanent breach of trust. The caller decides — and the honest options are "sync first" or
 * "confirm you are throwing this away".
 */
export async function wipeOfflineData(options: { force?: boolean } = {}) {
  if (!offlineSupported()) return { wiped: false, queued: 0 };
  const database = offlineDb();
  const queued = await database.outbox.where("status").notEqual("rejected").count();

  if (queued > 0 && !options.force) {
    return { wiped: false, queued };
  }

  await database.transaction(
    "rw",
    database.outbox,
    database.attachments,
    database.cache,
    async () => {
      await database.outbox.clear();
      await database.attachments.clear();
      await database.cache.clear();
    },
  );
  return { wiped: true, queued };
}

/**
 * §14's storage guard: "warn at 80% of browser quota; never silently drop queued items."
 *
 * The second clause is why this only ever reports. A cache eviction policy would be easy to add here
 * and would eventually, on a full device, delete a queued photo — which is the failure the whole
 * section is written to prevent. So when space runs short the answer is to tell the person to sync,
 * not to make room by throwing away the thing that cannot be recovered.
 */
export async function storageStanding() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { known: false as const, usage: 0, quota: 0, pct: 0, warn: false };
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const pct = quota > 0 ? Math.round((usage / quota) * 100) : 0;
  return { known: true as const, usage, quota, pct, warn: pct >= 80 };
}

/**
 * Asks the browser to keep this data through storage pressure.
 *
 * Best-effort by design: Chrome grants it silently to installed apps, Safari prompts or refuses, and
 * a refusal is not an error worth surfacing — the queue still works, it is just evictable. Worth
 * asking for exactly because the queue holds work that exists nowhere else.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
