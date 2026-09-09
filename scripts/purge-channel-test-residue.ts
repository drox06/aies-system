import { db } from "../src/lib/db";

/**
 * Removes residue left by `tests/server/core/collab/channel.test.ts` against the shared database.
 *
 * That file's own `afterAll` deletes everything it tracks — notifications, audit rows, messages,
 * members, channels, tasks, users — each step wrapped so one failure does not abort the rest (see
 * the file itself). It still leaks when the process is killed mid-run or the suite times out before
 * `afterAll` gets to run at all; nothing inside a test can protect against that.
 *
 * Found 2026-09-02 verifying docs/DECISIONS.md #162: "Linking <hex>", "Threads <hex>", "Edits <hex>",
 * "Promoting <hex>", "Reactions <hex>", "Reading <hex>" and an archived "Archived <hex>" were showing
 * up on the live /channels list for a fresh e2e account — every one matching the fixture's own naming,
 * `` `${label} ${suffix}` `` where `suffix = randomUUID().slice(0, 8)`.
 *
 * Matched on that exact shape: one of the fixture's fixed labels, a space, then an 8-character hex
 * suffix, and nothing else in the name. A person naming a real discussion "Threads abc12345" is not
 * a pattern anybody types by hand, but the match still requires the *whole* name to be exactly that
 * shape — no prefix, no trailing text — so nothing a person wrote by hand can collide with it.
 *
 * Deliberately narrow, same discipline as purge-my-test-residue.ts: it does not touch the `@test.local`
 * users the fixture also creates (purge-my-test-residue.ts already sweeps every one of those, by
 * domain, across all suites — duplicating that here would just be two scripts disagreeing about who
 * owns it) and it does not touch EventOutbox.
 *
 * Dry run by default. Pass `--apply` to write.
 */

const APPLY = process.argv.includes("--apply");

/** The fixture's channel labels, verbatim from channel.test.ts's `makeChannel` call sites. */
const FIXTURE_LABELS = [
  "Linking",
  "Threads",
  "Edits",
  "Archived",
  "Reactions",
  "Reading",
  "Promoting",
  "Private",
];
/** `` `${label} ${suffix}` ``, suffix = randomUUID().slice(0, 8) — the whole name, nothing more. */
const FIXTURE_NAME = new RegExp(`^(?:${FIXTURE_LABELS.join("|")}) [0-9a-f]{8}$`);

async function main() {
  const allChannels = await db.channel.findMany({
    select: { id: true, name: true, isPrivate: true, archivedAt: true, createdAt: true },
  });
  if (process.argv.includes("--debug-all")) {
    console.log(`ALL CHANNELS IN DB (${allChannels.length})`);
    for (const c of allChannels) {
      console.log(
        `  ${c.id}  ${JSON.stringify(c.name)}${c.isPrivate ? " private" : ""}${c.archivedAt ? " archived" : ""}  ${c.createdAt.toISOString()}`,
      );
    }
    console.log();
  }
  const channels = allChannels.filter((c) => FIXTURE_NAME.test(c.name));

  const channelIds = channels.map((c) => c.id);
  const messages = await db.message.findMany({
    where: { channelId: { in: channelIds } },
    select: { id: true },
  });
  const members = await db.channelMember.findMany({
    where: { channelId: { in: channelIds } },
    select: { id: true },
  });
  const audit = await db.auditLog.findMany({
    where: { entityId: { in: channelIds } },
    select: { id: true },
  });
  const notifications = await db.notification.findMany({
    where: { entityId: { in: channelIds } },
    select: { id: true },
  });

  console.log(APPLY ? "APPLYING\n" : "DRY RUN — pass --apply to write\n");
  console.log(`CHANNELS (${channels.length})`);
  for (const c of channels) {
    console.log(
      `  ${c.id}  "${c.name}"${c.isPrivate ? " private" : ""}${c.archivedAt ? " archived" : ""}  ${c.createdAt.toISOString()}`,
    );
  }
  console.log(`\nMESSAGES (${messages.length})`);
  console.log(`MEMBERS (${members.length})`);
  console.log(`AUDIT LOG ROWS (${audit.length})`);
  console.log(`NOTIFICATIONS (${notifications.length})`);

  if (channels.length === 0) {
    console.log("\nNothing to remove.");
    return;
  }
  if (!APPLY) {
    console.log("\nNothing written. Re-run with --apply to delete the above.");
    return;
  }

  // Children first, so a foreign-key constraint never stops the run half way.
  await db.notification.deleteMany({ where: { entityId: { in: channelIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: channelIds } } });
  await db.message.deleteMany({ where: { channelId: { in: channelIds } } });
  await db.channelMember.deleteMany({ where: { channelId: { in: channelIds } } });
  await db.channel.deleteMany({ where: { id: { in: channelIds } } });

  console.log(
    `\nDeleted ${channels.length} channel(s), ${messages.length} message(s), ` +
      `${members.length} member row(s), ${audit.length} audit row(s), ` +
      `${notifications.length} notification(s).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
