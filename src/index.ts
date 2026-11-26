import "dotenv/config";
import { createAppServer } from "./app.js";
import { loadConfig } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createOidcAdapter } from "./modules/auth/oidc.js";

async function start(): Promise<void> {
  let appPool: ReturnType<typeof createPool> | undefined;
  let migrationPool: ReturnType<typeof createPool> | undefined;
  try {
    const config = loadConfig(process.env);
    appPool = createPool(config.databaseUrl, {
      max: config.dbPoolMax,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      statement_timeout: config.dbStatementTimeoutMs,
    });
    migrationPool = createPool(config.migrationDatabaseUrl, {
      max: 1,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      statement_timeout: config.dbStatementTimeoutMs,
    });
    await runMigrations(migrationPool);

    const oidc = createOidcAdapter({
      issuerUrl: config.oidcIssuerUrl,
      clientId: config.oidcClientId,
      clientSecret: config.oidcClientSecret,
    });
    const server = createAppServer({ pool: appPool, oidc, config });
    server.once("error", () => {
      process.stderr.write('{"level":"error","event":"server_bind_failed"}\n');
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      process.stdout.write(
        `${JSON.stringify({
          level: "info",
          event: "server_started",
          host: config.host,
          port: config.port,
          nodeEnv: config.nodeEnv,
        })}\n`,
      );
    });

    const shutdown = (): void => {
      server.close(() => {
        void Promise.all([appPool?.end(), migrationPool?.end()]);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write(
      '{"level":"error","event":"startup_failed","message":"Check configuration and database availability."}\n',
    );
    await Promise.all([appPool?.end(), migrationPool?.end()]);
    process.exitCode = 1;
  }
}

void start();
