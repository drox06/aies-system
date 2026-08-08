"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc/client";

// specs/00-foundation.md §7.7: "Global search bar (Cmd/Ctrl+K)."
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = trpc.search.query.useQuery({ q: query }, { enabled: open && query.length > 0 });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,27,42,0.5)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 1000,
      }}
      onClick={() => setOpen(false)}
    >
      <div
        style={{ background: "white", borderRadius: 8, padding: 16, width: 480, maxHeight: "60vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search... (Esc to close)"
          style={{ width: "100%", padding: 8, fontSize: 16 }}
        />
        <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
          {results.data?.map((result) => (
            <li key={`${result.entityType}:${result.entityId}`} style={{ padding: "6px 0" }}>
              <a href={result.href} onClick={() => setOpen(false)}>
                {result.title}
              </a>
              <span style={{ color: "#5A6B7D", fontSize: 12, marginLeft: 8 }}>
                {result.entityType}
              </span>
            </li>
          ))}
          {query.length > 0 && results.data?.length === 0 && <li>No results.</li>}
        </ul>
      </div>
    </div>
  );
}
