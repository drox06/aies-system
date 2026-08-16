import { db } from "../src/lib/db";

/** Read-only diagnostic for a `migrate dev` that claims a migration "was modified". */
async function main() {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `select id, migration_name, checksum, started_at, finished_at, rolled_back_at,
            applied_steps_count, logs
     from _prisma_migrations
     where migration_name like '%module_03%' or migration_name like '%rfq_supplier_fk%'
     order by started_at`,
  );
  console.log(JSON.stringify(rows, null, 2));

  const dupes = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `select migration_name, count(*)::int as n from _prisma_migrations
     group by migration_name having count(*) > 1`,
  );
  console.log("duplicates:", JSON.stringify(dupes));

  const schemas = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `select table_schema from information_schema.tables where table_name = '_prisma_migrations'`,
  );
  console.log("_prisma_migrations lives in:", JSON.stringify(schemas));
  console.log(
    "search_path:",
    JSON.stringify(await db.$queryRawUnsafe<Record<string, unknown>[]>(`show search_path`)),
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
