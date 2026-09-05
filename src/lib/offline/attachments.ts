import { offlineDb, offlineSupported } from "./db";
import { compressForQueue } from "./photos";

/**
 * specs/04-operations-projects.md §14's photos, from the camera to the server.
 *
 * ## Why the blob is stored before it is uploaded
 *
 * A photograph taken in a plant has nowhere to go. Uploading it is not an option, and holding it in
 * a React state variable means it survives exactly as long as the tab does — a phone that locks its
 * screen and gets backgrounded by iOS has thrown the evidence away, and the technician will not
 * find out until the report is missing a photo weeks later.
 *
 * So it goes into IndexedDB next to the write it belongs to, in the same database and the same
 * transaction, and neither can be evicted without the other.
 *
 * ## Why upload comes before the write, on drain
 *
 * The server write carries file ids. Uploading first means the write always references files that
 * exist; writing first would leave a delivery attempt pointing at photographs that may never
 * arrive — a record that looks complete and is not, which is worse than one that is honestly still
 * queued.
 *
 * A photo that has already uploaded records its `serverFileId` and is not sent again, so a write
 * that is retried after a network failure does not re-upload three megabytes each time.
 */

export interface UploadFn {
  (input: { blob: Blob; filename: string; mimeType: string }): Promise<string>;
}

/**
 * Compresses and stores a captured image against a queued write.
 *
 * Compression happens here, at capture, rather than at upload — §14 asks for it and the reason is
 * quota. Twelve uncompressed photographs is tens of megabytes of IndexedDB against a budget the
 * browser may measure in the same units, and the eviction that follows takes the queue with it.
 */
export async function attachPhoto(clientUuid: string, file: File) {
  const database = offlineDb();
  const compressed = await compressForQueue(file);
  const id = crypto.randomUUID();

  await database.attachments.add({
    id,
    clientUuid,
    blob: compressed.blob,
    filename: compressed.filename,
    mimeType: compressed.mimeType,
    size: compressed.blob.size,
    serverFileId: null,
  });

  return {
    id,
    reencoded: compressed.reencoded,
    originalSize: compressed.originalSize,
    size: compressed.blob.size,
  };
}

/**
 * Uploads whatever is still pending for this write and returns every file id it owns.
 *
 * Called by the drain before the write is replayed. Throws on the first failure, which leaves the
 * item queued and the already-uploaded photos marked — so the retry resumes rather than restarts.
 */
export async function uploadPending(clientUuid: string, upload: UploadFn): Promise<string[]> {
  if (!offlineSupported()) return [];
  const database = offlineDb();
  const rows = await database.attachments.where("clientUuid").equals(clientUuid).toArray();

  const ids: string[] = [];
  for (const row of rows) {
    if (row.serverFileId) {
      ids.push(row.serverFileId);
      continue;
    }
    const serverFileId = await upload({
      blob: row.blob,
      filename: row.filename,
      mimeType: row.mimeType,
    });
    await database.attachments.update(row.id, { serverFileId });
    ids.push(serverFileId);
  }
  return ids;
}

/**
 * Like `uploadPending`, but pulls one tagged attachment — the closing signature photo — out from the
 * rest, so a "close delivery" write can send it as `signatureFileId` and everything else as
 * `photoFileIds`. Resumes per file exactly as `uploadPending` does; only the grouping differs.
 *
 * Matched by filename rather than a new column on the attachments table, so a single photo capture
 * flow (`attachPhoto`) still serves both cases — the caller tags the one that matters by naming the
 * `File` before attaching it, and this is the only place that name is read back.
 */
export async function uploadPendingSplit(
  clientUuid: string,
  upload: UploadFn,
  isSignature: (filename: string) => boolean,
): Promise<{ signatureFileId: string | null; photoFileIds: string[] }> {
  if (!offlineSupported()) return { signatureFileId: null, photoFileIds: [] };
  const database = offlineDb();
  const rows = await database.attachments.where("clientUuid").equals(clientUuid).toArray();

  let signatureFileId: string | null = null;
  const photoFileIds: string[] = [];

  for (const row of rows) {
    let serverFileId = row.serverFileId;
    if (!serverFileId) {
      serverFileId = await upload({
        blob: row.blob,
        filename: row.filename,
        mimeType: row.mimeType,
      });
      await database.attachments.update(row.id, { serverFileId });
    }
    if (isSignature(row.filename)) signatureFileId = serverFileId;
    else photoFileIds.push(serverFileId);
  }

  return { signatureFileId, photoFileIds };
}

/** What this write is carrying, for the queue list — "3 photos, 780 KB". */
export async function attachmentSummary(clientUuid: string) {
  if (!offlineSupported()) return { count: 0, bytes: 0, uploaded: 0 };
  const rows = await offlineDb().attachments.where("clientUuid").equals(clientUuid).toArray();
  return {
    count: rows.length,
    bytes: rows.reduce((total, row) => total + row.size, 0),
    uploaded: rows.filter((row) => row.serverFileId).length,
  };
}

/**
 * Sends one blob through the platform's normal upload route.
 *
 * Deliberately the same endpoint everything else uses, rather than a field-specific one. A second
 * upload path would be a second place for the storage rules, the size ceilings and the access
 * checkers to be enforced — and the field one would be the copy nobody kept in step.
 */
export function browserUpload(entityType: string, entityId: string): UploadFn {
  return async ({ blob, filename, mimeType }) => {
    const body = new FormData();
    body.append("file", new File([blob], filename, { type: mimeType }));
    body.append("entityType", entityType);
    body.append("entityId", entityId);
    body.append("category", "operations");

    const response = await fetch("/api/files", { method: "POST", body });
    if (!response.ok) {
      throw new Error(`Upload failed (${response.status})`);
    }
    const result = (await response.json()) as { id?: string };
    if (!result.id) throw new Error("Upload returned no file id.");
    return result.id;
  };
}
