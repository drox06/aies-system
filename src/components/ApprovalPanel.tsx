"use client";

import { trpc } from "@/lib/trpc/client";

// specs/00-foundation.md §7.4: "Reusable <ApprovalPanel />" — shows a record's approval history.
// Deciding happens from the global inbox (/approvals), not here, since eligibility to decide a
// step depends on the viewer's role/permissions, which this component doesn't resolve itself.
export function ApprovalPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const requests = trpc.approvals.listForEntity.useQuery({ entityType, entityId });

  if (requests.isPending) return <p>Loading approvals...</p>;
  if (requests.isError) return <p style={{ color: "#B3261E" }}>Could not load approvals.</p>;
  if (requests.data.length === 0) return <p>No approval requests yet.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {requests.data.map((request) => (
        <li key={request.id} style={{ borderBottom: "1px solid #DCE3EB", padding: "6px 0" }}>
          <strong>{request.status}</strong>
          {" — requested "}
          {new Date(request.requestedAt).toLocaleString()}
          <ul>
            {request.actions.map((action) => (
              <li key={action.id} style={{ fontSize: 14 }}>
                {action.decision} by {action.approverId}
                {action.isFallback && " (fallback)"} — {new Date(action.at).toLocaleString()}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
