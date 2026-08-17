"use client";

import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * The project list.
 *
 * A `Project` has existed since session 1 with no screen at all — §12's close-out checklist is the
 * first thing that made one necessary. Deliberately thin, and deliberately without contract value or
 * budget: Spec.md §4.3 gates cost and margin, and a project list is exactly where a technician would
 * otherwise read them.
 */
export default function ProjectsPage() {
  const projects = trpc.operations.listProjects.useQuery({});

  return (
    <div className="space-y-4">
      <PageHeader
        title="Projects"
        description="Where §12's close-out lives — and what is still holding each one open."
      />

      <Card className="p-4">
        {projects.isPending && <p className="text-sm text-text-muted">Loading…</p>}
        {projects.error && <p className="text-sm text-danger">{projects.error.message}</p>}
        {projects.data?.length === 0 && (
          <p className="text-sm text-text-muted">
            No projects yet. §2: a project exists for new-project, installation and after-sales work
            that runs long enough to need one.
          </p>
        )}

        <ul className="space-y-2 text-sm">
          {projects.data?.map((project) => (
            <li key={project.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                  <span className="tabular">{project.code}</span> — {project.name}
                </Link>
                <span className="flex items-center gap-2 text-xs text-text-muted">
                  <StatusBadge
                    tone={project.closeOut?.status === "approved" ? "approved" : "pending"}
                  >
                    {project.closeOut?.status === "approved" ? "Closed" : project.status}
                  </StatusBadge>
                  {project.plannedEnd && <DateCell value={project.plannedEnd} />}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {project.account.name} · {project._count.tickets} ticket(s)
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
