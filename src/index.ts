import "dotenv/config";
import { createAppServer } from "./app.js";
import { loadConfig } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createOidcAdapter } from "./modules/auth/oidc.js";
import { createSourcedAnswerProvider } from "./modules/chat/answers/service.js";
import { createGeminiModel } from "./providers/gemini.js";
import { createTavilyWebSearch } from "./providers/tavily.js";

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
    const model = createGeminiModel(process.env);
    const search = createTavilyWebSearch(process.env);
    const answerProvider = createSourcedAnswerProvider({ model, search });
    const server = createAppServer({
      pool: appPool,
      oidc,
      config,
      model,
      answerProvider,
      adminStatus: {
        model: process.env.MODEL_API_KEY?.trim()
          ? "configured"
          : "not_configured",
        webSearch: process.env.WEB_SEARCH_API_KEY?.trim()
          ? "configured"
          : "not_configured",
        embeddings: process.env.EMBEDDING_API_KEY?.trim()
          ? "configured"
          : "not_configured",
        vectorStore: process.env.VECTOR_STORE_URL?.trim()
          ? "configured"
          : "not_configured",
        backup:
          process.env.BACKUP_STATUS === "configured"
            ? "configured"
            : "not_reported",
      },
    });
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
