"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A click-toggled dropdown.
 *
 * Deliberately not hover-driven. Spec.md §6.6 requires field views to be usable one-handed with
 * gloves and forbids hover-dependent interactions — and on a touch screen `:hover` either never
 * fires or sticks after a tap, so a hover menu is either unopenable or unclosable. Opening on
 * click, closing on outside-click or Escape, is the only behaviour that works on both.
 */
export function Menu({
  trigger,
  children,
  align = "right",
  className,
  triggerClassName,
  label,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  align?: "left" | "right";
  className?: string;
  triggerClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // pointerdown rather than click so the menu closes before the underlying control activates.
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-30 mt-1 w-56 rounded-md border border-border bg-surface p-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2",
        // A disabled item stays visible rather than vanishing: "you may not do this, and here is
        // why" (via `title`) is more use than a menu that silently has one fewer row.
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}
