"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

// specs/00-foundation.md §7.6: "This component is the heart of the 'replace external chat apps'
// requirement — invest in it." Merges comments and audit-log entries (which cover status
// changes too — see src/server/core/comments/activity-feed.ts) into one chronological stream,
// with a comment box at the bottom. No design system yet (module 00 session 5); the investment
// here is in the data/interaction model, not visual polish.
export function ActivityFeed({ entityType, entityId }: { entityType: string; entityId: string }) {
  const utils = trpc.useUtils();
  const feed = trpc.comments.activityFeed.useQuery({ entityType, entityId });
  const createComment = trpc.comments.create.useMutation({
    onSuccess: () => {
      setBody("");
      void utils.comments.activityFeed.invalidate({ entityType, entityId });
    },
  });
  const editComment = trpc.comments.edit.useMutation({
    onSuccess: () => {
      setEditingId(null);
      void utils.comments.activityFeed.invalidate({ entityType, entityId });
    },
  });
  const deleteComment = trpc.comments.delete.useMutation({
    onSuccess: () => void utils.comments.activityFeed.invalidate({ entityType, entityId }),
  });

  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setError(null);
    try {
      await createComment.mutateAsync({ entityType, entityId, body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post comment.");
    }
  }

  async function handleSaveEdit(commentId: string) {
    setError(null);
    try {
      await editComment.mutateAsync({ commentId, body: editBody });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save edit.");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {feed.isPending && <p>Loading activity...</p>}
      {feed.isError && <p style={{ color: "#B3261E" }}>Could not load activity.</p>}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {feed.data?.map((entry) =>
          entry.kind === "audit" ? (
            <li
              key={`audit-${entry.id}`}
              style={{ padding: "6px 0", fontSize: 13, color: "#5A6B7D" }}
            >
              {entry.actorLabel} — {entry.summary}
              <br />
              {new Date(entry.at).toLocaleString()}
            </li>
          ) : (
            <li
              key={`comment-${entry.id}`}
              style={{ borderBottom: "1px solid #DCE3EB", padding: "8px 0" }}
            >
              <strong>{entry.authorId}</strong>{" "}
              <span style={{ color: "#5A6B7D", fontSize: 13 }}>
                {new Date(entry.at).toLocaleString()}
                {entry.editedAt && " (edited)"}
              </span>
              {editingId === entry.id ? (
                <div>
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    style={{ display: "block", width: "100%" }}
                  />
                  <button type="button" onClick={() => void handleSaveEdit(entry.id)}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <p style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{entry.body}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(entry.id);
                      setEditBody(entry.body);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteComment.mutate({ commentId: entry.id })}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ),
        )}
      </ul>

      {error && <p style={{ color: "#B3261E" }}>{error}</p>}

      <form onSubmit={handleSubmit}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment..."
          style={{ display: "block", width: "100%", minHeight: 60 }}
        />
        <button type="submit" disabled={createComment.isPending}>
          {createComment.isPending ? "Posting..." : "Comment"}
        </button>
      </form>
    </div>
  );
}
