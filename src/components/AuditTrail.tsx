"use client";

import { trpc } from "@/lib/trpc/client";

// specs/00-foundation.md §5: "A reusable <AuditTrail entityType entityId /> component renders
// the history on every record." Bare-bones styling on purpose — the design system lands in
// module 00 session 5.
export function AuditTrail({ entityType, entityId }: { entityType: string; entityId: string }) {
  const trail = trpc.audit.listForEntity.useQuery({ entityType, entityId });

  if (trail.isPending) return <p>Loading activity...</p>;
  if (trail.isError) return <p style={{ color: "#B3261E" }}>Could not load activity.</p>;
  if (trail.data.length === 0) return <p>No activity yet.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {trail.data.map((entry) => (
        <li
          key={entry.id}
          style={{ borderBottom: "1px solid #DCE3EB", padding: "6px 0", fontSize: 14 }}
        >
          <strong>{entry.actorLabel}</strong> — {entry.summary}
          <br />
          <span style={{ color: "#5A6B7D" }}>{new Date(entry.at).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
