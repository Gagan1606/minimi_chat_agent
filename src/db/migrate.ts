import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Pool } from "pg";

const DEFAULT_MIGRATIONS_DIRECTORY = resolve(
  process.cwd(),
  "src/db/migrations",
);

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      "momos:migrations",
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS momos_migration (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const name of migrations) {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const alreadyApplied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM momos_migration WHERE name = $1",
        [name],
      );
      if (alreadyApplied.rowCount) {
        if (alreadyApplied.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO momos_migration (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        "momos:migrations",
      ]);
    } finally {
      client.release();
    }
  }
}
