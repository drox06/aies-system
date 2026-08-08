"use client";

import { useId, useState } from "react";
import { BASE_CURRENCY, formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Money in a table. Right-aligned and tabular so decimal points line up down the column
 *  (Spec.md §6.5). */
export function MoneyCell({
  value,
  currency = BASE_CURRENCY,
  className,
}: {
  value: number | string | null | undefined;
  currency?: string;
  className?: string;
}) {
  return (
    <span className={cn("tabular text-right", className)}>{formatMoney(value, currency)}</span>
  );
}

export function DateCell({
  value,
  withTime = false,
  className,
}: {
  value: Date | string | null | undefined;
  withTime?: boolean;
  className?: string;
}) {
  const text = withTime ? formatDateTime(value) : formatDate(value);
  // The machine-readable value goes in <time datetime> so exports and copy-paste keep full
  // precision even though the label is DD MMM YYYY.
  const iso = value instanceof Date ? value.toISOString() : (value ?? undefined);
  return (
    <time dateTime={iso} className={cn("tabular whitespace-nowrap", className)}>
      {text}
    </time>
  );
}

/**
 * Currency entry. Holds the raw string while focused so a half-typed "1234." is not reformatted
 * out from under the user, then formats on blur. `onValueChange` emits a number or null, never a
 * partially-parsed string.
 */
export function MoneyInput({
  value,
  onValueChange,
  currency = BASE_CURRENCY,
  className,
  id,
  ...props
}: {
  value: number | null;
  onValueChange: (value: number | null) => void;
  currency?: string;
} & Omit<React.ComponentProps<"input">, "value" | "onChange" | "type">) {
  const generatedId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value === null ? "" : String(value));

  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-text-muted"
      >
        {currency === "PHP" ? "₱" : currency}
      </span>
      <input
        id={id ?? generatedId}
        inputMode="decimal"
        className={cn(
          "flex h-9 w-full rounded-md border border-border bg-surface py-1 pr-3 pl-7 text-right text-sm tabular",
          "placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const cleaned = raw.replace(/[,\s₱]/g, "");
          if (cleaned === "") {
            onValueChange(null);
            return;
          }
          const n = Number(cleaned);
          if (Number.isFinite(n)) onValueChange(n);
        }}
        onBlur={() => setDraft(null)}
        {...props}
      />
    </div>
  );
}

/** Initials avatar. No image: there is no photo field on User, and a coloured disc with initials
 *  is both faster and more legible at table density than a fallback icon repeated 50 times. */
export function UserAvatar({
  name,
  size = 28,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";

  // Deterministic hue per person so the same user keeps the same colour across screens, kept in
  // the brand's blue range rather than a rainbow.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const mix = 55 + (Math.abs(hash) % 35);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-text-invert select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        backgroundColor: `color-mix(in srgb, var(--color-blue-600) ${mix}%, var(--color-navy-900))`,
      }}
      title={name}
    >
      {initials}
    </span>
  );
}
