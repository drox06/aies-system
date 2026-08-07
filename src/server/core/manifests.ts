import { buildModuleRegistry, type ModuleManifest } from "./module-registry";

// Each business module appends its manifest.ts export here as it's built (specs/00-foundation.md
// §3; module boundary rules in Spec.md §3.6). Empty until module 01 lands.
const manifests: readonly ModuleManifest[] = [];

export const registry = buildModuleRegistry(manifests);
