import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.migrationDatabaseUrl, {
    max: 1,
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
    statement_timeout: config.dbStatementTimeoutMs,
  });
  try {
    await runMigrations(pool);
    process.stdout.write('{"level":"info","event":"migrations_applied"}\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    '{"level":"error","event":"migration_failed","message":"Check database configuration and migration status."}\n',
  );
  process.exitCode = 1;
});
