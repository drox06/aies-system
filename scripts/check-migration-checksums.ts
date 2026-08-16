import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";

/**
 * Read-only. Compares each migration file's SHA-256 against the checksum Prisma recorded when it
 * applied it.
 *
 * Exists because `prisma migrate dev` responds to *any* mismatch with "we need to reset the schema…
 * all data will be lost", which is a catastrophic answer to what is usually a line-ending change:
 * `git add` normalises CRLF to LF, and the file Prisma hashed at apply time is then no longer the
 * file on disk. The migration ran; only the fingerprint moved.
 *
 * The other harmless case, and the one that actually bit this build: a **rolled-back** row left
 * behind by a failed first attempt. `20260815140000_module_03_supplier_sales_order` failed once on a
 * UTF-8 BOM that PowerShell redirection had written into the file; it was resolved with
 * `migrate resolve --rolled-back`, the BOM was stripped, and it applied cleanly. But
 * `migrate resolve --rolled-back` *retains* the failed row, with the checksum of the file as it was
 * when it failed — so the table holds two rows for one migration, one of which can never match the
 * file again. `migrate dev` compares by name, finds the stale one, and offers to reset the database.
 *
 * So: diagnose before you reset. This prints every row per migration, and `--fix` repairs the two
 * harmless cases — a line-endings-only difference, and a rolled-back row's meaningless checksum. It
 * refuses to touch anything else, because a migration whose *SQL* changed after it successfully
 * applied is a real problem that a checksum update would bury.
 */
const DIR = join(process.cwd(), "prisma", "schema", "migrations");
const FIX = process.argv.includes("--fix") || process.argv.includes("--fix-line-endings");

interface MigrationRow {
  id: string;
  migration_name: string;
  checksum: string;
  rolled_back_at: Date | null;
  finished_at: Date | null;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const rows = await db.$queryRawUnsafe<MigrationRow[]>(
    `select id, migration_name, checksum, rolled_back_at, finished_at
     from _prisma_migrations order by started_at`,
  );

  // Every row, not one per name: the whole point is that a migration can have more than one.
  const byName = new Map<string, MigrationRow[]>();
  for (const row of rows) {
    const list = byName.get(row.migration_name) ?? [];
    list.push(row);
    byName.set(row.migration_name, list);
  }

  let mismatches = 0;
  let fixed = 0;
  let unrepairable = 0;

  for (const name of readdirSync(DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const bytes = readFileSync(join(DIR, name, "migration.sql"));
    const actual = sha256(bytes);
    const applied = byName.get(name) ?? [];

    if (applied.length === 0) {
      console.log(`  ${name}: not applied to this database`);
      continue;
    }

    for (const row of applied) {
      if (row.checksum === actual) {
        console.log(`  ${name}: ok${row.rolled_back_at ? " (rolled-back row)" : ""}`);
        continue;
      }

      mismatches++;
      const asLf = bytes.toString("utf8").replace(/\r\n/g, "\n");
      const asCrlf = asLf.replace(/\n/g, "\r\n");
      const lineEndingsOnly = sha256(asLf) === row.checksum || sha256(asCrlf) === row.checksum;
      const rolledBack = row.rolled_back_at !== null;

      const why = rolledBack
        ? "rolled-back row — this attempt never applied, so its checksum means nothing"
        : lineEndingsOnly
          ? "line endings only"
          : "THE SQL ITSELF CHANGED after a successful apply";
      console.log(`  ${name}: MISMATCH (${why})`);
      console.log(`      recorded ${row.checksum}`);
      console.log(`      on disk  ${actual}`);

      if (!rolledBack && !lineEndingsOnly) {
        unrepairable++;
        console.log(
          `      Not repairable here. The database and the file no longer describe the same ` +
            `thing, and re-recording the checksum would hide that.`,
        );
        continue;
      }
      if (!FIX) {
        console.log(`      Re-run with --fix to re-record this row's checksum.`);
        continue;
      }

      // By row id, never by name — the successful row next to it must not be touched. `id` is
      // varchar(36) here, not uuid, so it is compared as text.
      await db.$executeRawUnsafe(
        `update _prisma_migrations set checksum = $1 where id = $2`,
        actual,
        row.id,
      );
      fixed++;
      console.log(`      checksum re-recorded.`);
    }
  }

  console.log(
    `\n${mismatches} mismatch(es)${FIX ? `, ${fixed} repaired` : ""}` +
      (unrepairable > 0 ? `, ${unrepairable} needing a human` : "") +
      `. Nothing in the schema was changed by this script.`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
