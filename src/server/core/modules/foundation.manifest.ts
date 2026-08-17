import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 00's own manifest.
 *
 * It exists mainly so the foundation's pages appear in the sidebar through the same mechanism
 * every business module will use, rather than being hard-coded into the shell and becoming the
 * one special case nobody remembers to update.
 *
 * `permissions` is intentionally empty: foundation permissions are seeded directly by
 * prisma/seed.ts, and re-declaring them here would give two sources of truth for the same keys.
 * `emits` *is* declared, because that is what lets the registry catch a future module trying to
 * claim `approval.approved`, and what lets one legitimately subscribe to it.
 */
export const foundationManifest = defineManifest({
  key: "foundation",
  name: "Foundation",
  version: "0.5.0",
  models: [],
  permissions: [],
  emits: ["approval.requested", "approval.approved", "approval.rejected"],
  consumes: [],
  nav: [
    // No Home entry: `/` is a redirect to the first section a person can reach, not a page. It
    // becomes module 09's dashboard when that lands — see src/app/page.tsx.
    // Everyone can reach their own approval inbox; it is empty unless something is waiting on
    // them, so gating it on a permission would only hide it from the people who need it.
    { label: "Approvals", href: "/approvals", icon: "check", order: 2 },
    {
      label: "Users",
      href: "/admin/users",
      icon: "users",
      permission: "admin.manage_users",
      order: 100,
      group: "Admin",
    },
  ],
});
