"use client";

import { useRef, useState } from "react";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * Upload target for `POST /api/files`, the endpoint built in session 4.
 *
 * Uses a plain multipart POST rather than a tRPC mutation because the route already exists and
 * handles the sha256 dedup, the executable denylist and the sharp derivative server-side — the
 * client's only jobs are to pick files and report progress.
 *
 * Spec.md §6.6 requires this to work on a phone in a plant, so the whole zone is a label wrapping
 * a real file input: drag-and-drop is an enhancement on top, never the only way in.
 */
/** What POST /api/files returns per file — the FileObject row. */
export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function FileDropzone({
  entityType,
  entityId,
  onUploaded,
  accept,
  multiple = true,
  category,
  className,
}: {
  entityType: string;
  entityId: string;
  /** Receives the created FileObject rows, so a caller can store the id it just produced. */
  onUploaded?: (files: UploadedFile[]) => void;
  accept?: string;
  multiple?: boolean;
  /**
   * specs/00-foundation.md §7.2's two upload limits: 50 MB by default, 200 MB for operations.
   * "operations" is the site-video case the spec names — a field visit is exactly what it meant.
   */
  category?: "default" | "operations";
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(0);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(files.length);
    const uploaded: UploadedFile[] = [];
    try {
      // Sequential rather than parallel: a phone on plant LTE uploading four 8MB site photos at
      // once is how you get four timeouts instead of four files.
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        body.append("entityType", entityType);
        body.append("entityId", entityId);
        if (category) body.append("category", category);

        const res = await fetch("/api/files", { method: "POST", body });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Upload failed for ${file.name}`);
        }
        uploaded.push((await res.json()) as UploadedFile);
        setBusy((n) => n - 1);
      }
      onUploaded?.(uploaded);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors",
        dragging ? "border-blue-400 bg-surface-2" : "border-border hover:bg-surface-2",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => void upload(e.target.files)}
      />
      {busy > 0 ? (
        <span>Uploading... ({busy} remaining)</span>
      ) : (
        <>
          <span className="font-medium">Drop files here, or tap to choose</span>
          <span className="text-xs text-text-muted">
            Images are resized for the web automatically.
          </span>
        </>
      )}
    </label>
  );
}
