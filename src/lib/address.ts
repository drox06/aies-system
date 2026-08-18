/**
 * Turning a stored address into one line somebody can read, or hand to a maps app.
 *
 * Addresses are `Json` on purpose (prisma/schema/crm.prisma): "Philippine addresses do not decompose
 * cleanly into the usual fields (barangay, subdivision, building), and every downstream consumer
 * wants the whole block, not its parts." That decision is right and it leaves this job — the block
 * has to become a string eventually, and doing it in each screen would give the delivery note, the
 * PDF header and the driver's navigation link three different answers for the same site.
 *
 * ## Why the order is fixed rather than taken from the object
 *
 * `Object.values()` would follow whatever order the keys happen to sit in, which depends on how the
 * record was written and is not stable across edits. An address whose parts reorder themselves
 * between two views of the same site reads as a data error to whoever notices. So known keys are
 * emitted in Philippine postal order, and anything unrecognised is appended afterwards rather than
 * dropped — a field somebody added deliberately should not vanish because this function had not
 * heard of it.
 */

/** Philippine postal order, narrowest to widest. */
const ORDER = [
  "unit",
  "building",
  "street",
  "subdivision",
  "barangay",
  "district",
  "city",
  "municipality",
  "province",
  "region",
  "postalCode",
  "country",
] as const;

const IGNORED = new Set(["lat", "lng", "latitude", "longitude", "notes", "id"]);

export function formatAddress(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const used = new Set<string>();

  for (const key of ORDER) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim()) {
      parts.push(entry.trim());
      used.add(key);
    }
  }

  // Anything this function has not heard of, in the object's own order. Coordinates and free notes
  // are skipped: they are not part of a postal address and would read as noise on a delivery note.
  for (const [key, entry] of Object.entries(record)) {
    if (used.has(key) || IGNORED.has(key)) continue;
    if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
  }

  return parts.length > 0 ? parts.join(", ") : null;
}
