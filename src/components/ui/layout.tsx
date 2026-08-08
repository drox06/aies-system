import { cn } from "@/lib/utils";

/** Title row for a page. Keeps heading size, spacing and action placement identical everywhere so
 *  ten modules do not each invent their own. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-start gap-3", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A card. The default container for anything sitting on the page background (Spec.md §6.4:
 *  "cards on --aies-surface with --aies-border"). */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-md border border-border bg-surface p-4", className)}
      {...props}
    />
  );
}

/**
 * Spec.md §6.6: record pages are two-column — fields left, activity feed right. Collapses to one
 * column below `lg`, with the feed *after* the fields, since on a phone the record itself is what
 * was navigated to.
 */
export function RecordLayout({
  children,
  aside,
  className,
}: {
  children: React.ReactNode;
  aside: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_22rem]", className)}>
      <div className="min-w-0">{children}</div>
      <aside className="min-w-0">{aside}</aside>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
