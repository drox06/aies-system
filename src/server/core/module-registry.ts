// The mechanism that makes modules interconnectable (specs/00-foundation.md §3).
// Every business module exports a `manifest.ts` built with `defineManifest`; `src/server/core/
// manifests.ts` imports all of them and calls `buildModuleRegistry` once at boot. Navigation and
// the permission matrix are assembled from the result — never hand-maintained elsewhere.

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
  defaultRoles?: string[];
}

export interface NavEntry {
  label: string;
  href: string;
  icon?: string;
  permission?: string;
  order?: number;
  group?: string;
}

export type EventHandler = (
  payload: unknown,
  meta: { event: string; attempt: number },
) => Promise<void> | void;

export interface EventSubscription {
  event: string;
  handler: EventHandler;
}

export interface SearchResult {
  entityType: string;
  entityId: string;
  title: string;
  href: string;
}

export interface SearchProvider {
  entityType: string;
  label: string;
  search: (query: string) => Promise<SearchResult[]>;
}

// Tightens to a Zod schema once zod is introduced (module 00 session 2+).
export type SettingsSchema = unknown;

export interface ModuleManifest {
  key: string;
  name: string;
  version: string;
  models: string[];
  permissions: PermissionDef[];
  emits: string[];
  consumes: EventSubscription[];
  nav?: NavEntry[];
  settings?: SettingsSchema;
  searchProviders?: SearchProvider[];
}

/** Identity helper so module authors get type-checking and autocomplete on manifest.ts. */
export function defineManifest(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}

export interface ModuleRegistry {
  modules: ModuleManifest[];
  permissions: PermissionDef[];
  nav: NavEntry[];
  searchProviders: SearchProvider[];
  eventSubscribers: ReadonlyMap<string, EventSubscription[]>;
  eventOwners: ReadonlyMap<string, string>;
}

export interface RegistryOptions {
  /** Module keys currently turned off in settings. Their nav, permissions, and event
   *  subscriptions are excluded from the built registry, but they still participate in
   *  collision validation — a disabled module must not be able to silently claim a key that
   *  breaks another module the moment someone re-enables it. */
  disabledModuleKeys?: readonly string[];
}

export class ModuleRegistryError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Module registry validation failed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ModuleRegistryError";
  }
}

export function buildModuleRegistry(
  manifests: readonly ModuleManifest[],
  options: RegistryOptions = {},
): ModuleRegistry {
  const issues: string[] = [];

  const moduleOwners = new Map<string, ModuleManifest>();
  for (const m of manifests) {
    const existing = moduleOwners.get(m.key);
    if (existing && existing !== m) {
      issues.push(`Duplicate module key "${m.key}".`);
    }
    moduleOwners.set(m.key, m);
  }

  const permissionOwners = new Map<string, string>();
  for (const m of manifests) {
    for (const p of m.permissions) {
      const owner = permissionOwners.get(p.key);
      if (owner && owner !== m.key) {
        issues.push(`Permission key "${p.key}" is defined by both "${owner}" and "${m.key}".`);
      } else {
        permissionOwners.set(p.key, m.key);
      }
    }
  }

  const eventOwners = new Map<string, string>();
  for (const m of manifests) {
    for (const eventName of m.emits) {
      const owner = eventOwners.get(eventName);
      if (owner && owner !== m.key) {
        issues.push(`Event "${eventName}" is emitted by both "${owner}" and "${m.key}".`);
      } else {
        eventOwners.set(eventName, m.key);
      }
    }
  }

  for (const m of manifests) {
    for (const sub of m.consumes) {
      if (!eventOwners.has(sub.event)) {
        issues.push(`Module "${m.key}" consumes unknown event "${sub.event}".`);
      }
    }
  }

  if (issues.length > 0) {
    throw new ModuleRegistryError(issues);
  }

  const disabled = new Set(options.disabledModuleKeys ?? []);
  const activeModules = manifests.filter((m) => !disabled.has(m.key));

  const nav = activeModules
    .flatMap((m) => m.nav ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const eventSubscribers = new Map<string, EventSubscription[]>();
  for (const m of activeModules) {
    for (const sub of m.consumes) {
      const list = eventSubscribers.get(sub.event) ?? [];
      list.push(sub);
      eventSubscribers.set(sub.event, list);
    }
  }

  return {
    modules: activeModules,
    permissions: activeModules.flatMap((m) => m.permissions),
    nav,
    searchProviders: activeModules.flatMap((m) => m.searchProviders ?? []),
    eventSubscribers,
    eventOwners: new Map(
      [...eventOwners].filter(([, owner]) => moduleOwners.has(owner) && !disabled.has(owner)),
    ),
  };
}
