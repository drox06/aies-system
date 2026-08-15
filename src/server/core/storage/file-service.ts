import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { AuthedUser } from "@/server/core/rbac/types";
import { canAccessFile, canManageFile } from "./access";

/**
 * Reading and removing the files attached to a record.
 *
 * Uploading has been possible since session 4 (`POST /api/files`); nothing could *list* what had
 * been uploaded, so every attachment in the app was a single id stored on its parent row. That is
 * fine for a certificate — there is exactly one — and useless for the thing a site visit actually
 * brings back, which is eleven photographs.
 *
 * Both operations run the same registered checkers the download route uses, so a module decides who
 * may see and who may remove its own files in one place rather than in every caller.
 */

export interface AttachedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploaderId: string;
  uploaderLabel: string;
  createdAt: Date;
  /** True when the browser can render it inline — the difference between looking and downloading. */
  isImage: boolean;
  /** Set only for images: the resized derivative exists, so the list can show thumbnails. */
  hasWebVariant: boolean;
  /** Whether *this* user may remove it, so the UI offers the control rather than discovering a 403. */
  canRemove: boolean;
}

export async function listEntityFilesService(
  user: AuthedUser,
  input: { entityType: string; entityId: string },
): Promise<AttachedFile[]> {
  const files = await db.fileObject.findMany({
    where: { entityType: input.entityType, entityId: input.entityId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (files.length === 0) return [];

  // One access decision covers the whole set: every row here shares an entityType and an entityId,
  // which is exactly what the checkers read.
  const first = files[0]!;
  if (!(await canAccessFile(user, first))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to the files on this record.",
    });
  }

  const uploaderIds = [...new Set(files.map((f) => f.uploaderId))];
  const users = await db.user.findMany({
    where: { id: { in: uploaderIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const rows: AttachedFile[] = [];
  for (const file of files) {
    rows.push({
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      uploaderId: file.uploaderId,
      uploaderLabel: nameById.get(file.uploaderId) ?? "Someone no longer here",
      createdAt: file.createdAt,
      isImage: file.mimeType.startsWith("image/"),
      hasWebVariant: file.webDerivativeKey !== null,
      canRemove: await canManageFile(user, file),
    });
  }
  return rows;
}

/**
 * Takes a file off a record.
 *
 * **Soft**, like everything else in this build (Spec.md §10). The bytes stay in the bucket and the
 * row keeps its sha256, which matters for the case this exists for: somebody attaches the wrong
 * scan to a distributor agreement, removes it, and a week later has to prove what was and was not
 * on the record at the moment somebody else made a decision. A hard delete answers that question
 * with silence.
 *
 * It refuses when the file is still being *pointed at* by its parent record — a principal's
 * `priceListFileId`, an accreditation's certificate — because that would leave a dangling id whose
 * only symptom is a broken link on a page nobody opens until it matters. Clearing the reference is
 * the parent module's job, and the message says so.
 */
export async function removeEntityFileService(
  user: AuthedUser,
  actorLabel: string,
  input: { fileId: string; reason?: string | null },
): Promise<{ removed: true; filename: string }> {
  const file = await db.fileObject.findFirst({
    where: { id: input.fileId, deletedAt: null },
  });
  if (!file) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That file is already gone." });
  }
  if (!(await canManageFile(user, file))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the person who uploaded this file, or someone who manages this kind of record, " +
        "can remove it.",
    });
  }

  const holder = await findReferenceHolder(file.id);
  if (holder) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `This file is the record's ${holder}. Replace it there rather than removing it here — ` +
        `removing it would leave the record pointing at a file that no longer exists.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.fileObject.update({
      where: { id: file.id },
      data: { deletedAt: new Date() },
    });

    await writeAuditLog(tx, {
      actorId: user.id,
      actorLabel,
      action: "file_removed",
      entityType: file.entityType,
      entityId: file.entityId,
      summary:
        `Removed "${file.filename}"` + (input.reason ? ` — ${input.reason}` : " from this record"),
      diff: { fileId: { from: file.id, to: null } },
    });
  });

  return { removed: true, filename: file.filename };
}

/**
 * The field naming this file, if any record still points at it.
 *
 * Enumerated rather than derived: these are the four columns in the schema that hold a `FileObject`
 * id, and a query per column is cheap next to the alternative, which is a dangling reference nobody
 * notices. A fifth column added later and not listed here is a bug — the test in
 * tests/server/core/storage/file-service.test.ts pins the ones that exist today.
 */
async function findReferenceHolder(fileId: string): Promise<string | null> {
  const [accreditation, agreement, priceList, rfqResponse, inspection, customerPo] =
    await Promise.all([
      db.accreditationRecord.findFirst({
        where: { certificateFileId: fileId, deletedAt: null },
        select: { id: true },
      }),
      db.principalProspect.findFirst({
        where: { distributorAgreementFileId: fileId, deletedAt: null },
        select: { id: true },
      }),
      db.principalProspect.findFirst({
        where: { priceListFileId: fileId, deletedAt: null },
        select: { id: true },
      }),
      db.supplierQuoteRequest.findFirst({
        where: { responseFileId: fileId, deletedAt: null },
        select: { id: true },
      }),
      db.inspectionRequest.findFirst({
        where: { reportFileId: fileId, deletedAt: null },
        select: { id: true },
      }),
      db.customerPO.findFirst({
        where: { fileId, deletedAt: null },
        select: { id: true },
      }),
    ]);

  if (accreditation) return "accreditation certificate";
  if (agreement) return "signed distributor agreement";
  if (priceList) return "current price list";
  if (rfqResponse) return "supplier's own quotation";
  if (inspection) return "inspection report";
  if (customerPo) return "customer purchase order";
  return null;
}
