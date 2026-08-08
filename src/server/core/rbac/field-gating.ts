/**
 * Strips fields from a record unless the caller holds the required permission — enforced in the
 * service layer, never the UI (specs/00-foundation.md §4.2: "cost and margin fields are stripped
 * in the service layer... when the user lacks finance.view_cost"). Verify by inspecting the
 * serialised API response, not the rendered page.
 */
export function stripFieldsUnlessPermitted<T extends Record<string, unknown>>(
  record: T,
  fields: readonly (keyof T)[],
  hasPermission: boolean,
): T {
  if (hasPermission) return record;
  const clone = { ...record };
  for (const field of fields) {
    delete clone[field];
  }
  return clone;
}

export function stripFieldsFromListUnlessPermitted<T extends Record<string, unknown>>(
  records: readonly T[],
  fields: readonly (keyof T)[],
  hasPermission: boolean,
): T[] {
  if (hasPermission) return [...records];
  return records.map((record) => stripFieldsUnlessPermitted(record, fields, hasPermission));
}
