import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names, with later Tailwind utilities beating earlier conflicting ones.
 * The shadcn/ui convention — every component takes `className` and passes it through this, so a
 * call site can override a component's own styling without `!important` or specificity games.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
