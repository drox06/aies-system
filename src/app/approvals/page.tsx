"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

// specs/00-foundation.md §7.4: "a global 'Awaiting my approval' inbox."
export default function ApprovalsInboxPage() {
  const utils = trpc.useUtils();
  const inbox = trpc.approvals.myInbox.useQuery();
  const decide = trpc.approvals.decide.useMutation({
    onSuccess: () => void utils.approvals.myInbox.invalidate(),
  });
  const [error, setError] = useState<string | null>(null);

  async function handleDecide(requestId: string, decision: "approved" | "rejected") {
    setError(null);
    try {
      await decide.mutateAsync({ requestId, decision });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record decision.");
    }
  }

  return (
    <main style={{ maxWidth: 700, margin: "3rem auto", fontFamily: "system-ui" }}>
      <h1>Awaiting my approval</h1>
      {error && <p style={{ color: "#B3261E" }}>{error}</p>}
      {inbox.isPending && <p>Loading...</p>}
      {inbox.data?.length === 0 && <p>Nothing awaiting your approval.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {inbox.data?.map((request) => (
          <li
            key={request.id}
            style={{ border: "1px solid #DCE3EB", borderRadius: 4, padding: 12, marginBottom: 8 }}
          >
            <div>
              {request.entityType} — {request.entityId}
            </div>
            <div style={{ color: "#5A6B7D", fontSize: 14 }}>
              Requested {new Date(request.requestedAt).toLocaleString()}
            </div>
            <button
              type="button"
              onClick={() => void handleDecide(request.id, "approved")}
              disabled={decide.isPending}
              style={{ marginTop: 8, marginRight: 8 }}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void handleDecide(request.id, "rejected")}
              disabled={decide.isPending}
            >
              Reject
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
