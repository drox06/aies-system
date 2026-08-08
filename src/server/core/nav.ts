import { registry as defaultRegistry } from "@/server/core/manifests";
import type { ModuleRegistry } from "@/server/core/module-registry";

export interface VisibleNavEntry {
  label: string;
  href: string;
  icon: string | null;
  group: string | null;
}

/**
 * The sidebar for one user: every manifest's nav entries, minus the ones they cannot reach.
 *
 * Filtering happens on the server so an unreachable route is never *named* in a response. A nav
 * label is itself a disclosure — "Users" is mild, but a later "Cost analysis" would tell an
 * unprivileged user the feature exists, and Spec.md §4.3 strips cost data precisely so it does
 * not. Dropping the entry is therefore the correct behaviour, not disabling it.
 *
 * Lives here rather than inline in the router so it is testable without pulling in Auth.js, which
 * cannot load outside the Next.js runtime — the same router/service split used since session 3.
 * Takes the registry as a parameter so tests can supply a fake one.
 */
export function visibleNavFor(
  permissions: ReadonlySet<string>,
  reg: Pick<ModuleRegistry, "nav"> = defaultRegistry,
): VisibleNavEntry[] {
  return reg.nav
    .filter((entry) => !entry.permission || permissions.has(entry.permission))
    .map((entry) => ({
      label: entry.label,
      href: entry.href,
      icon: entry.icon ?? null,
      group: entry.group ?? null,
    }));
}
