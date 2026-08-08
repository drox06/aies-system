import type { AuthedUser } from "./types";

/**
 * Record-level scoping (specs/00-foundation.md §4.2): each business module registers a scoper
 * for the entity types it owns — e.g. CRM registers "account" with a rule that restricts `sales`
 * users without `crm.view_all` to records they own or are a team member on. Core just holds the
 * registry; it has no opinion on any specific entity type.
 */
export type ScopeResolver<Where = Record<string, unknown>> = (user: AuthedUser) => Where;

const scopeResolvers = new Map<string, ScopeResolver>();

export function registerScope(entityType: string, resolver: ScopeResolver): void {
  if (scopeResolvers.has(entityType)) {
    throw new Error(`A scope resolver is already registered for entity type "${entityType}".`);
  }
  scopeResolvers.set(entityType, resolver);
}

/** Returns `{}` (no restriction) if no module has registered a scoper for this entity type. */
export function scopeFor(entityType: string, user: AuthedUser): Record<string, unknown> {
  const resolver = scopeResolvers.get(entityType);
  return resolver ? resolver(user) : {};
}

/** Test-only: clears the registry between test files. */
export function __resetScopeRegistryForTests(): void {
  scopeResolvers.clear();
}
