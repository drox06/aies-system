import { db } from "../src/lib/db";

/**
 * Gives every named user the president's authority, for practice — and takes it back again.
 *
 *   npx tsx scripts/practice-authority.ts --grant
 *   npx tsx scripts/practice-authority.ts --revoke
 *
 * ## Why this is a script with an undo rather than a change to the seed
 *
 * The company asked for it on 2026-08-21 so that DJ, PD, EM and KJ can walk the whole platform
 * without being stopped by a permission that belongs to somebody else. That is a sensible thing to
 * want while learning it, and a dangerous thing to leave in place afterwards — so the grant is
 * additive, reversible in one command, and leaves each person's real role attached underneath.
 *
 * **Their own role stays.** The president role is added, not swapped in. Anything that reads *which*
 * role somebody holds — the timesheet approver order, the approval fallback chain, an announcement
 * addressed to operations — keeps working, and revoking is a matter of removing one row.
 *
 * ## What this does not switch off
 *
 * Permissions are not the only control in the platform, and the ones that survive are the ones worth
 * knowing about during a practice run:
 *
 *  - **Self-approval is refused by identity, not by permission.** Somebody submitting an expense or a
 *    cash advance still cannot approve their own, however many roles they hold.
 *  - **Every gate that reads a record's state.** The downpayment gate, the client's method-statement
 *    approval, the final billing gate: those refuse because the work is not done, and no amount of
 *    authority changes that.
 *
 * So the practice run still meets most of the refusals. What it stops testing is *who* is allowed to
 * do what — which is worth a second pass on real roles before go-live.
 */

const NAMED = [
  "dj@aieselectromech.com",
  "kj@aieselectromech.com",
  "pd@aieselectromech.com",
  "em@aieselectromech.com",
];

async function main() {
  const grant = process.argv.includes("--grant");
  const revoke = process.argv.includes("--revoke");

  if (grant === revoke) {
    console.error("Pass exactly one of --grant or --revoke.");
    process.exitCode = 2;
    return;
  }

  const president = await db.role.findUnique({ where: { key: "president" } });
  if (!president) {
    console.error("No president role. Run `npx prisma db seed` first.");
    process.exitCode = 1;
    return;
  }

  const users = await db.user.findMany({
    where: { email: { in: NAMED }, deletedAt: null },
    select: { id: true, name: true, email: true, roles: { select: { roleId: true } } },
  });

  const missing = NAMED.filter((email) => !users.some((user) => user.email === email));
  for (const email of missing) console.log(`  not found: ${email}`);

  for (const user of users) {
    const has = user.roles.some((role) => role.roleId === president.id);

    if (grant) {
      if (has) {
        console.log(`  ${user.name.padEnd(4)} already had it`);
        continue;
      }
      await db.userRole.create({ data: { userId: user.id, roleId: president.id } });
      console.log(`  ${user.name.padEnd(4)} granted president alongside their own role`);
    } else {
      if (!has) {
        console.log(`  ${user.name.padEnd(4)} did not have it`);
        continue;
      }
      await db.userRole.deleteMany({ where: { userId: user.id, roleId: president.id } });
      console.log(`  ${user.name.padEnd(4)} back to their own role only`);
    }
  }

  /*
    Said out loud because it is the part that surprises people.

    Permissions are read into the session when somebody signs in, so anybody already signed in keeps
    the authority they had until they sign out and back in. On a grant that means the change looks
    not to have worked; on a revoke it means somebody keeps an authority that has been taken away,
    which matters rather more.
  */
  console.log(
    "\nPermissions are read at sign-in. Anybody currently signed in keeps what they had until they" +
      "\nsign out and back in — which matters most on a revoke.",
  );

  const after = await db.user.findMany({
    where: { deletedAt: null },
    select: { name: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { name: "asc" },
  });
  console.log("\nRoles now:");
  for (const user of after) {
    console.log(`  ${user.name.padEnd(14)} ${user.roles.map((r) => r.role.key).join(", ")}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
