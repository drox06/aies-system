import { buildModuleRegistry, type ModuleManifest } from "./module-registry";
import { crmManifest } from "./modules/crm.manifest";
import { foundationManifest } from "./modules/foundation.manifest";
import { quotationManifest } from "./modules/quotation.manifest";

// Each business module appends its manifest.ts export here as it's built (specs/00-foundation.md
// §3; module boundary rules in Spec.md §3.6).
const manifests: readonly ModuleManifest[] = [foundationManifest, crmManifest, quotationManifest];

export const registry = buildModuleRegistry(manifests);
