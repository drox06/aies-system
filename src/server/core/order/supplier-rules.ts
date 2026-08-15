/**
 * Supplier facts the screen and the server both need (specs/03-order-procurement.md §2).
 *
 * Pure — no Prisma, no node builtins — so a component can import it. Same split as
 * inquiry-lifecycle.ts, accreditation-rules.ts and costing.ts, and enforced the same way: this file
 * is on `UI_SAFE_SERVER_MODULES` in eslint.config.mjs and supplier-service.ts is not.
 */

export const SUPPLIER_ENTITY_TYPE = "Supplier";
export const SUPPLIER_DOCUMENT_TYPE = "supplier";

/** The permission ISO 9001 clause 8.4 hangs off. Narrower than maintaining the directory. */
export const SUPPLIER_APPROVE_PERMISSION = "supplier.approve";

export type SupplierApprovalState = "approved" | "expired" | "none";

/**
 * An approval with a date in the past is not an approval, whatever the boolean says.
 *
 * Derived rather than stored, for the same reason §5c's price-list check is: a flag that needs a
 * nightly sweep to stay true is a flag that is wrong between sweeps, and this one gates buying
 * decisions. Deriving it also keeps the screen and the server from ever disagreeing about a
 * supplier's status, which is the failure that makes an audit finding.
 *
 * `expired` and `none` are kept apart because they mean opposite things about the past: one says
 * somebody did the work and it lapsed, the other says nobody has done it yet.
 */
export function supplierApprovalState(supplier: {
  isApproved: boolean;
  approvalExpiry: Date | string | null;
}): SupplierApprovalState {
  if (!supplier.isApproved) return "none";
  if (!supplier.approvalExpiry) return "approved";
  return new Date(supplier.approvalExpiry).getTime() < Date.now() ? "expired" : "approved";
}
