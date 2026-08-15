"use client";

import { useState } from "react";
import { Download, FileText, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Everything attached to one record: what is there, look at it, save it, take it off.
 *
 * The company's complaint that produced this was concrete and worth keeping in view — *"the uploaded
 * files should have visible indicators that a file is uploaded"*. Before this, uploading produced a
 * toast and then nothing: the dropzone looked exactly as it had a moment earlier, so the only way to
 * find out whether the agreement had actually attached was to save, reload, and read a sentence.
 *
 * Three deliberate choices:
 *
 * **Images render inline.** A site visit comes back with photographs, and a photograph you have to
 * download to see is one nobody looks at. The thumbnail is the `-web` derivative the upload path
 * already generates, so a plant LTE connection is not asked for the 8 MB original until somebody
 * clicks.
 *
 * **Download is a separate control from view.** `?download=1` serves the original as an attachment
 * under its own filename; clicking the image opens it full-size inline. Both were asked for.
 *
 * **Removal is offered only to people who may actually do it.** `canRemove` comes from the server's
 * registered checker, so the button is absent rather than present-and-refusing.
 */
export function Attachments({
  entityType,
  entityId,
  label,
  hint,
  accept,
  category,
  emptyText = "Nothing attached yet.",
  canUpload = true,
  compact = false,
  onChanged,
}: {
  entityType: string;
  entityId: string;
  label?: string;
  hint?: string;
  accept?: string;
  /** §7.2's upload ceiling — "operations" raises it to 200 MB for site video. */
  category?: "default" | "operations";
  emptyText?: string;
  canUpload?: boolean;
  /** Hides the dropzone until asked for — for panels where uploading is the rare action. */
  compact?: boolean;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const [preview, setPreview] = useState<{ id: string; filename: string } | null>(null);
  const [uploading, setUploading] = useState(!compact);

  const files = trpc.files.forEntity.useQuery({ entityType, entityId }, { retry: false });
  const remove = trpc.files.remove.useMutation();

  const rows = files.data ?? [];
  const refresh = () => {
    void utils.files.forEntity.invalidate({ entityType, entityId });
    onChanged?.();
  };

  return (
    <div>
      {label && <p className="text-sm font-medium">{label}</p>}
      {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}

      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">{emptyText}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {rows.map((file) => (
            <li
              key={file.id}
              className="flex w-40 flex-col overflow-hidden rounded-md border border-border"
            >
              {file.isImage ? (
                <button
                  type="button"
                  className="block h-24 w-full bg-surface-2"
                  onClick={() => setPreview({ id: file.id, filename: file.filename })}
                  title={`Open ${file.filename}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- /api/files redirects to
                      a short-lived signed URL, which next/image cannot pre-optimise. */}
                  <img
                    src={`/api/files/${file.id}${file.hasWebVariant ? "?variant=web" : ""}`}
                    alt={file.filename}
                    className="h-24 w-full object-cover"
                  />
                </button>
              ) : (
                <div className="flex h-24 w-full items-center justify-center bg-surface-2">
                  <FileText className="size-7 text-text-muted" />
                </div>
              )}

              <div className="flex flex-col gap-1 p-2">
                <span className="truncate text-xs font-medium" title={file.filename}>
                  {file.filename}
                </span>
                <span className="text-[11px] text-text-muted">
                  {formatSize(file.size)} · <DateCell value={file.createdAt} />
                </span>
                <div className="flex items-center gap-1">
                  <Button asChild variant="ghost" size="sm" className="h-6 px-1.5">
                    <a href={`/api/files/${file.id}?download=1`} title="Save a copy">
                      <Download />
                    </a>
                  </Button>
                  {file.canRemove && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-danger"
                      title="Remove from this record"
                      disabled={remove.isPending}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync({ fileId: file.id });
                          toastSuccess(`Removed ${file.filename}.`);
                          refresh();
                        } catch (error) {
                          toastError(error);
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canUpload &&
        (uploading ? (
          <FileDropzone
            className="mt-2 p-4"
            entityType={entityType}
            entityId={entityId}
            accept={accept}
            category={category}
            onUploaded={(uploaded) => {
              toastSuccess(
                uploaded.length === 1
                  ? `Attached ${uploaded[0]!.filename}.`
                  : `Attached ${uploaded.length} files.`,
              );
              if (compact) setUploading(false);
              refresh();
            }}
          />
        ) : (
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setUploading(true)}>
            Attach a file…
          </Button>
        ))}

      {/* Full size, in place. A lightbox rather than a new tab because the person looking at a site
          photo is comparing it against the questions on the same screen. */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/80 p-6"
          role="dialog"
          aria-label={preview.filename}
          onClick={() => setPreview(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img
            src={`/api/files/${preview.id}`}
            alt={preview.filename}
            className="max-h-full max-w-full rounded-md object-contain"
          />
          <Button
            variant="secondary"
            size="icon"
            className="absolute top-4 right-4"
            aria-label="Close"
            onClick={() => setPreview(null)}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
