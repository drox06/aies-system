/**
 * Every icon name a module manifest is allowed to ask for.
 *
 * ## Why this is a separate file
 *
 * The nav renders `ICONS[entry.icon] ?? placeholder`, and the placeholder is deliberately quiet — a
 * small dot, so an unmapped icon does not shout. That is right for an entry with no icon and wrong
 * for catching one that was meant to have one, and it has now happened three times: `truck` shipped
 * unmapped with module 03's supplier entry, then `receipt` and `phone` with module 05's finance
 * entries. Each survived a review, because a quiet dot is exactly what a nav entry with no icon is
 * supposed to look like.
 *
 * Keeping the *names* here, apart from the components, buys two checks the map alone could not:
 *
 *   - **Compile time.** `AppShell`'s map is typed `Record<NavIconName, LucideIcon>`, so a name added
 *     here without a picture fails the build.
 *   - **Test time.** A test walks every registered manifest and asserts each icon it asks for is in
 *     this list, so requesting a name nobody has mapped fails the suite rather than rendering a dot.
 *
 * The list is the vocabulary; the map is the pictures. Neither can drift from the other in silence.
 */
export const NAV_ICON_NAMES = [
  // Module 00 — foundation.
  "check",
  "users",
  // Module 01 — CRM and inquiry.
  "sun",
  "columns",
  "building",
  "inbox",
  "badge-check",
  "handshake",
  "file-text",
  // Module 02 — quotation.
  "check-circle",
  // Module 03 — order and procurement.
  "truck",
  "clipboard-list",
  "package",
  // Module 04 — operations and projects.
  "wrench",
  "wallet",
  "clipboard-check",
  "shield-check",
  "folder-kanban",
  // Module 05 — finance, billing and collections.
  "receipt",
  "phone",
  "banknote",
  // Module 06 — collaboration.
  "list-checks",
  "message-square",
  "calendar",
  "megaphone",
] as const;

export type NavIconName = (typeof NAV_ICON_NAMES)[number];

export function isNavIconName(name: string): name is NavIconName {
  return (NAV_ICON_NAMES as readonly string[]).includes(name);
}
