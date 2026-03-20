import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { getBrainstormApiRoot } from "../src/packageRoot.js";
import { loadOptionalPackageEnvFile } from "../src/runtime/loadOptionalEnvFile.js";

loadOptionalPackageEnvFile();

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const migrationsDir = path.join(getBrainstormApiRoot(), "migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedVersions = new Set(
      (await client.query<{ version: string }>("select version from schema_migrations order by version asc")).rows.map(
        (row) => row.version
      )
    );

    for (const file of files) {
      if (appliedVersions.has(file)) continue;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
      console.log(`applied migration ${file}`);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
