import "dotenv/config";
import { createAppServer } from "./app.js";
import { loadConfig } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createOidcAdapter } from "./modules/auth/oidc.js";
import { createSourcedAnswerProvider } from "./modules/chat/answers/service.js";
import { createGeminiModel } from "./providers/gemini.js";
import { createTavilyWebSearch } from "./providers/tavily.js";
import { createGeminiEmbeddingProvider } from "./providers/embedding/gemini.js";
import { createQdrantVectorStore } from "./providers/vector-store/qdrant.js";
import { createHybridHistoryRetriever } from "./modules/retrieval/history.js";
import { createEmbeddingIndexer } from "./workers/embedding-indexer/index.js";
import type { MetricsPort } from "./shared/providers/contracts/index.js";

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
    const retrievalConfig = readRetrievalConfig(process.env);
    let historyRetriever;
    let indexer: ReturnType<typeof createEmbeddingIndexer> | undefined;
    if (retrievalConfig) {
      const retrievalMetrics = createRetrievalMetrics();
      const embeddings = createGeminiEmbeddingProvider(
        retrievalConfig.embedding,
      );
      const vectorStore = createQdrantVectorStore(retrievalConfig.vectorStore);
      try {
        await vectorStore.initialize();
      } catch {
        process.stderr.write(
          '{"level":"warn","event":"vector_store_unavailable","degraded":"lexical_history_search"}\n',
        );
      }
      historyRetriever = createHybridHistoryRetriever({
        pool: appPool,
        embeddings,
        vectorStore,
        metrics: retrievalMetrics,
      });
      indexer = createEmbeddingIndexer({
        pool: appPool,
        embeddings,
        vectorStore,
        batchSize: retrievalConfig.batchSize,
        maxAttempts: retrievalConfig.maxAttempts,
        metrics: retrievalMetrics,
      });
    }
    const server = createAppServer({
      pool: appPool,
      oidc,
      config,
      model,
      answerProvider,
      ...(historyRetriever ? { historyRetriever } : {}),
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
    if (indexer) {
      const pollIntervalMs = positiveInteger(
        process.env.EMBEDDING_INDEXER_POLL_INTERVAL_MS,
        1_000,
      );
      const runIndexer = (): void => {
        void indexer?.processBatch().catch(() => {
          process.stderr.write(
            '{"level":"error","event":"embedding_indexer_failed"}\n',
          );
        });
      };
      const indexerTimer = setInterval(runIndexer, pollIntervalMs);
      indexerTimer.unref();
      runIndexer();
    }

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

function createRetrievalMetrics(): MetricsPort {
  const previous = new Map<string, number>();
  return {
    increment(name, labels, value = 1) {
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "application_metric_increment",
          metric: name,
          value,
          ...(labels ? { labels } : {}),
        })}\n`,
      );
    },
    observe(name, value, labels) {
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "application_metric_observation",
          metric: name,
          value,
          ...(labels ? { labels } : {}),
        })}\n`,
      );
    },
    gauge(name, value, labels) {
      const key = `${name}:${JSON.stringify(labels ?? {})}`;
      if (previous.get(key) === value) return;
      previous.set(key, value);
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "application_metric_gauge",
          metric: name,
          value,
          ...(labels ? { labels } : {}),
        })}\n`,
      );
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer configuration value");
  }
  return parsed;
}

function readRetrievalConfig(environment: NodeJS.ProcessEnv) {
  if (environment.EMBEDDING_INDEXER_ENABLED === "false") return undefined;
  const localDefaults =
    !environment.NODE_ENV ||
    environment.NODE_ENV === "development" ||
    environment.NODE_ENV === "test";
  const embeddingApiKey =
    environment.EMBEDDING_API_KEY?.trim() ||
    environment.MODEL_API_KEY?.trim() ||
    "";
  const hasExplicitRetrievalConfig = [
    environment.EMBEDDING_PROVIDER,
    environment.EMBEDDING_MODEL,
    environment.EMBEDDING_API_KEY,
    environment.EMBEDDING_DIMENSIONS,
    environment.VECTOR_STORE_PROVIDER,
    environment.VECTOR_STORE_URL,
    environment.VECTOR_STORE_DIMENSIONS,
  ].some((value) => value?.trim());
  if (!hasExplicitRetrievalConfig && (!localDefaults || !embeddingApiKey))
    return undefined;
  const embeddingProvider =
    environment.EMBEDDING_PROVIDER?.trim() || (localDefaults ? "gemini" : "");
  const embeddingModel =
    environment.EMBEDDING_MODEL?.trim() ||
    (localDefaults ? "gemini-embedding-001" : "");
  const embeddingDimensions =
    environment.EMBEDDING_DIMENSIONS?.trim() || (localDefaults ? "768" : "");
  const vectorStoreProvider =
    environment.VECTOR_STORE_PROVIDER?.trim() ||
    (localDefaults ? "qdrant" : "");
  const vectorStoreUrl =
    environment.VECTOR_STORE_URL?.trim() ||
    (localDefaults ? "http://127.0.0.1:16333" : "");
  const vectorStoreDimensions =
    environment.VECTOR_STORE_DIMENSIONS?.trim() ||
    (localDefaults ? embeddingDimensions : "");
  const fields = [
    embeddingProvider,
    embeddingModel,
    embeddingApiKey,
    embeddingDimensions,
    vectorStoreProvider,
    vectorStoreUrl,
    vectorStoreDimensions,
  ];
  if (
    fields.some((value) => !value) ||
    embeddingProvider !== "gemini" ||
    vectorStoreProvider !== "qdrant"
  ) {
    throw new Error(
      "Semantic retrieval provider configuration is incomplete or unsupported",
    );
  }
  const dimensions = positiveInteger(embeddingDimensions, 0);
  if (dimensions !== positiveInteger(vectorStoreDimensions, 0)) {
    throw new Error("Embedding and vector dimensions must match");
  }
  const vectorUrl = vectorStoreUrl;
  const embeddingBaseUrl = environment.EMBEDDING_BASE_URL?.trim();
  const providerUrls: Array<[string, string]> = [
    ["VECTOR_STORE_URL", vectorUrl],
  ];
  if (embeddingBaseUrl)
    providerUrls.push(["EMBEDDING_BASE_URL", embeddingBaseUrl]);
  for (const [name, value] of providerUrls) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} must be a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${name} must use HTTP or HTTPS`);
    }
    if (environment.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error(`${name} must use HTTPS in production`);
    }
  }
  const vectorApiKey = environment.VECTOR_STORE_API_KEY?.trim();
  if (environment.NODE_ENV === "production" && !vectorApiKey) {
    throw new Error("VECTOR_STORE_API_KEY is required in production");
  }
  const metric = environment.VECTOR_STORE_METRIC?.trim() || "cosine";
  if (!["cosine", "dot", "euclid"].includes(metric))
    throw new Error("VECTOR_STORE_METRIC must be cosine, dot, or euclid");
  return {
    embedding: {
      apiKey: embeddingApiKey,
      model: embeddingModel,
      dimensions,
      ...(embeddingBaseUrl ? { baseUrl: embeddingBaseUrl } : {}),
      timeoutMs: positiveInteger(environment.EMBEDDING_TIMEOUT_MS, 2_000),
    },
    vectorStore: {
      baseUrl: vectorUrl,
      collection:
        environment.VECTOR_STORE_COLLECTION?.trim() || "momos-messages",
      dimensions,
      metric: metric as "cosine" | "dot" | "euclid",
      timeoutMs: positiveInteger(environment.VECTOR_STORE_TIMEOUT_MS, 1_000),
      ...(vectorApiKey ? { apiKey: vectorApiKey } : {}),
    },
    batchSize: positiveInteger(environment.EMBEDDING_INDEXER_BATCH_SIZE, 32),
    maxAttempts: positiveInteger(
      environment.EMBEDDING_INDEXER_MAX_ATTEMPTS,
      10,
    ),
  };
}

void start();
