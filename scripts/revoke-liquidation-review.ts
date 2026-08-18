import { db } from "../src/lib/db";

/**
 * Revokes `cash_advance.review_liquidation` from every role except finance.
 *
 * The manifest change alone is not enough. `prisma/seed.ts` prunes permissions no manifest declares,
 * but it never prunes **grants** — deliberately, because an admin can grant a permission to a role
 * through the admin screen and a blanket prune would silently undo that. So a role removed from
 * `defaultRoles` keeps the grant it was given the first time it was seeded.
 *
 * That gap is worth knowing about generally: `defaultRoles` decides what a *fresh* database gets,
 * not what an existing one keeps. Narrowing a permission needs a deliberate revoke like this one.
 *
 * Set by the company 2026-08-18: the liquidation reminder tells a technician to hand the paper to
 * finance, so finance is who checks it.
 */
async function main() {
  const permission = await db.permission.findUnique({
    where: { key: "cash_advance.review_liquidation" },
  });
  if (!permission) {
    console.log("Permission not present — nothing to revoke.");
    return;
  }

  const keep = await db.role.findUniqueOrThrow({ where: { key: "finance_officer" } });

  const doomed = await db.rolePermission.findMany({
    where: { permissionId: permission.id, roleId: { not: keep.id } },
    include: { role: { select: { key: true } } },
  });

  if (doomed.length === 0) {
    console.log("Already finance-only.");
    return;
  }

  await db.rolePermission.deleteMany({
    where: { permissionId: permission.id, roleId: { not: keep.id } },
  });
  console.log(`Revoked from: ${doomed.map((row) => row.role.key).join(", ")}.`);

  const left = await db.rolePermission.findMany({
    where: { permissionId: permission.id },
    include: { role: { select: { key: true } } },
  });
  console.log(`Now held by: ${left.map((row) => row.role.key).join(", ") || "(nobody)"}.`);
}

main().finally(() => db.$disconnect());
