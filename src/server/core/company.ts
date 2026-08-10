/**
 * AIES's own registered details.
 *
 * Spec.md §11.2 item 1 lists these as genuinely open, to be "entered manually in system settings at
 * first run (decision 32)" — and it warns why they matter: "every PDF header depends on them".
 *
 * Module 09 owns that settings screen and does not exist yet, so the company supplied the values
 * directly and they live here as constants. That is a deliberate interim, not an oversight:
 *
 *   - A `SystemSetting` table invented here would be a second settings mechanism for module 09 to
 *     reconcile, which is the trap the ISO 8.4 supplier register and module 03's `Supplier` were
 *     both kept out of.
 *   - Constants in one file are trivially findable and impossible to get half-migrated. When module
 *     09 lands, `getCompanyDetails()` becomes a settings read and every caller is already going
 *     through it.
 *
 * **Read through `getCompanyDetails()`, never by importing the constant.** That is the seam.
 */

export interface CompanyDetails {
  name: string;
  /**
   * The address as it should be *set*, one entry per printed line.
   *
   * Lines rather than one string: a document header is a narrow column, and letting it wrap on
   * whatever word happens to reach the edge broke "930 Doña Basilisa Yangco Street," across two
   * lines mid-address. Philippine addresses do not decompose into the usual structured fields
   * either, so this is the honest middle — the company decides where the breaks fall.
   */
  addressLines: string[];
  tin: string;
  contactNumber: string;
}

const AIES: CompanyDetails = {
  name: "AIES Electromechanical Corporation",
  addressLines: [
    "930 Doña Basilisa Yangco Street,",
    "Barangay Namayan, Mandaluyong City, 1550, Philippines",
  ],
  tin: "696-897-781-00000",
  contactNumber: "+639920073905",
};

/**
 * The company block for PDF headers and document footers.
 *
 * Synchronous today because it reads a constant. Returning it through a function anyway means the
 * signature does not change when module 09 makes it a database read — callers that already `await`
 * nothing will simply keep working, and the ones that need to can be made async in one place.
 */
export function getCompanyDetails(): CompanyDetails {
  return AIES;
}
