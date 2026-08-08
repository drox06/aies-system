import { cn } from "@/lib/utils";

/**
 * Spec.md §6.4 assigns each status a colour:
 *   draft grey · pending orange-500 · approved success · sent/active blue-600 ·
 *   overdue/failed danger · cancelled muted grey
 * Module 04's gate indicators reuse the same scale: released/issued green, awaiting orange,
 * blocked danger.
 *
 * The colour is carried by a tinted background and a solid dot, with the *label* in a separate
 * ink colour. That split exists because §6.2's contrast table rules orange-500 (3.1:1) out for
 * "body copy or a small label" — and a badge label is exactly a small label. So "pending" shows
 * an orange dot, which is what makes it recognisable at a glance, over --color-warning text,
 * which is legible. Anything that reads as a status keeps its spec colour; only the text ink is
 * substituted, and only where the spec's own table demands it.
 */
export type StatusTone =
  "draft" | "pending" | "approved" | "active" | "failed" | "cancelled" | "info";

const TONES: Record<StatusTone, { dot: string; ink: string; tint: string }> = {
  draft: {
    dot: "var(--color-text-muted)",
    ink: "var(--color-text-muted)",
    tint: "var(--color-surface-2)",
  },
  pending: {
    dot: "var(--color-orange-500)",
    ink: "var(--color-warning)",
    tint: "var(--color-orange-500)",
  },
  approved: {
    dot: "var(--color-success)",
    ink: "var(--color-success)",
    tint: "var(--color-success)",
  },
  active: {
    dot: "var(--color-blue-600)",
    ink: "var(--color-blue-600)",
    tint: "var(--color-blue-600)",
  },
  failed: { dot: "var(--color-danger)", ink: "var(--color-danger)", tint: "var(--color-danger)" },
  cancelled: {
    dot: "var(--color-border)",
    ink: "var(--color-text-muted)",
    tint: "var(--color-surface-2)",
  },
  info: { dot: "var(--color-info)", ink: "var(--color-info)", tint: "var(--color-info)" },
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  children: React.ReactNode;
}

export function StatusBadge({ tone, children, className, ...props }: StatusBadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        // 12% of the status colour over the surface: enough to read as a coloured chip, light
        // enough that the ink above still clears AA.
        backgroundColor: `color-mix(in srgb, ${t.tint} 12%, var(--color-surface))`,
        color: t.ink,
      }}
      {...props}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.dot }} />
      {children}
    </span>
  );
}
