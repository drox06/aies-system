"use client";

import { cn } from "@/lib/utils";

const FIELD =
  "flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-text " +
  "placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50 " +
  "aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(FIELD, className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(FIELD, "min-h-20 py-2", className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium text-text", className)} {...props} />;
}

/** Native select. Radix Select is used only where an option needs rich content — a plain select is
 *  faster to operate with a keyboard and is what a data-entry user expects. */
export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(FIELD, "pr-8", className)} {...props} />;
}
