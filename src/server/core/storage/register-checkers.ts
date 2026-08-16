/**
 * Loads every module that registers a file access or manage checker.
 *
 * ## The bug this fixes
 *
 * `access.ts` holds two module-level `Map`s, populated as a **side effect** of importing the module
 * that owns each entity type — `accreditation-access.ts`, `rfq-service.ts`, and seven others. That
 * is the right pattern; what was missing is anything guaranteeing those imports have happened by the
 * time somebody asks to download a file.
 *
 * `/api/files/[id]/route.ts` imports `canAccessFile` and nothing else. On a single long-lived Node
 * process it worked anyway, by accident: the tRPC route loads `src/server/api/root.ts`, which pulls
 * in every router and therefore every service, so the maps are populated by the time anyone clicks a
 * photograph. **Next.js bundles each route separately**, so on Vercel the files route is its own
 * serverless function whose graph contains none of those services. The maps are empty, and
 * `canAccessFile` falls through to its deliberately conservative default:
 *
 *     return file.uploaderId === user.id;
 *
 * Which means: in production, every file is downloadable **only by whoever uploaded it**. The
 * president cannot open a certificate PD uploaded. The operations manager approving a site
 * inspection cannot see its photographs. Nine entity types, all of them.
 *
 * The default is not the mistake — it is exactly right for an unregistered type, and it is why this
 * failed closed rather than open. The mistake was assuming registration had happened.
 *
 * ## Why a barrel rather than a lazier fix
 *
 * The alternatives are worse. Registering inside `access.ts` would invert the dependency and make
 * the storage core import every business module. Making each checker lazily `await import(...)` its
 * own module puts the same ordering problem one level down. An explicit list is greppable, fails
 * loudly when a module is renamed, and the cost is a slightly larger bundle on one route.
 *
 * **Add a line here when you register a new checker.** `file-access-registration.test.ts` asserts
 * that every module calling `registerFileAccessChecker` appears below, so forgetting is a red test
 * rather than a file somebody cannot open six months later.
 */

import "@/server/core/crm/accreditation-access";
import "@/server/core/crm/inspection-access";
import "@/server/core/crm/principal-access";
import "@/server/core/crm/principal-lifecycle";
import "@/server/core/operations/methodology-service";
import "@/server/core/operations/site-inspection-service";
import "@/server/core/order/customer-po-service";
import "@/server/core/order/goods-receipt-service";
import "@/server/core/order/supplier-po-service";
import "@/server/core/quotation/rfq-service";

/**
 * Exported so the import cannot be dropped as unused by a bundler or a well-meaning tidy-up.
 *
 * A bare side-effect import is exactly the kind of line that looks removable. This gives the route a
 * value to reference, which makes the dependency explicit to both the bundler and the next reader.
 */
export const FILE_CHECKERS_REGISTERED = true;
