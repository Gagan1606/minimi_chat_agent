import type { AppConfig } from "../app.js";

export interface RuntimeConfig extends AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  dbPoolMax: number;
  dbConnectTimeoutMs: number;
  dbStatementTimeoutMs: number;
  oidcIssuerUrl: string;
  oidcClientId: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const nodeEnv = environment.NODE_ENV?.trim() || "development";
  const appBaseUrl = requiredUrl(environment.APP_BASE_URL, "APP_BASE_URL");
  const databaseUrl = requiredDatabaseUrl(
    environment.DATABASE_URL,
    "DATABASE_URL",
  );
  const oidcIssuerUrl = requiredUrl(
    environment.OIDC_ISSUER_URL,
    "OIDC_ISSUER_URL",
  );
  const oidcRedirectUri = requiredUrl(
    environment.OIDC_REDIRECT_URI,
    "OIDC_REDIRECT_URI",
  );
  const sessionCookieSecure =
    environment.SESSION_COOKIE_SECURE === undefined
      ? nodeEnv === "production"
      : parseBoolean(
          environment.SESSION_COOKIE_SECURE,
          "SESSION_COOKIE_SECURE",
        );
  const platformAdminIssuer = requiredUrl(
    environment.PLATFORM_ADMIN_BOOTSTRAP_ISSUER,
    "PLATFORM_ADMIN_BOOTSTRAP_ISSUER",
  );
  const oidcScopes = (environment.OIDC_SCOPES || "openid profile email")
    .split(/\s+/)
    .filter(Boolean);
  if (!oidcScopes.includes("openid")) {
    throw new Error("OIDC_SCOPES must include openid");
  }
  if (
    nodeEnv === "production" &&
    [appBaseUrl, oidcIssuerUrl, oidcRedirectUri, platformAdminIssuer].some(
      (value) => new URL(value).protocol !== "https:",
    )
  ) {
    throw new Error("Production application and OIDC URLs must use HTTPS");
  }
  if (nodeEnv === "production" && !sessionCookieSecure) {
    throw new Error("SESSION_COOKIE_SECURE must be true in production");
  }
  const port = positiveInteger(environment.PORT, 3000, "PORT", 65_535);

  return {
    nodeEnv,
    host: environment.HOST?.trim() || "127.0.0.1",
    port,
    appBaseUrl,
    oidcRedirectUri,
    oidcScopes,
    oidcMfaAcrValues: (environment.OIDC_MFA_ACR_VALUES || "")
      .split(/\s+/)
      .filter(Boolean),
    oidcIssuerUrl,
    oidcClientId: requiredValue(environment.OIDC_CLIENT_ID, "OIDC_CLIENT_ID"),
    oidcClientSecret: requiredValue(
      environment.OIDC_CLIENT_SECRET,
      "OIDC_CLIENT_SECRET",
    ),
    sessionCookieName: environment.SESSION_COOKIE_NAME || "momos_session",
    oidcTransactionCookieName:
      environment.OIDC_TRANSACTION_COOKIE_NAME || "momos_oidc_transaction",
    sessionCookieSecure,
    sessionIdleTimeoutSeconds: positiveInteger(
      environment.SESSION_IDLE_TIMEOUT_SECONDS,
      3600,
      "SESSION_IDLE_TIMEOUT_SECONDS",
    ),
    sessionAbsoluteTimeoutSeconds: positiveInteger(
      environment.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
      86_400,
      "SESSION_ABSOLUTE_TIMEOUT_SECONDS",
    ),
    platformAdminBootstrap: {
      issuer: platformAdminIssuer,
      subject: requiredValue(
        environment.PLATFORM_ADMIN_BOOTSTRAP_SUBJECT,
        "PLATFORM_ADMIN_BOOTSTRAP_SUBJECT",
      ),
    },
    oidcStartMax: positiveInteger(
      environment.RATE_LIMIT_OIDC_START_MAX,
      10,
      "RATE_LIMIT_OIDC_START_MAX",
    ),
    oidcStartWindowSeconds: positiveInteger(
      environment.RATE_LIMIT_OIDC_START_WINDOW_SECONDS,
      900,
      "RATE_LIMIT_OIDC_START_WINDOW_SECONDS",
    ),
    databaseUrl,
    migrationDatabaseUrl: environment.MIGRATION_DATABASE_URL?.trim()
      ? requiredDatabaseUrl(
          environment.MIGRATION_DATABASE_URL,
          "MIGRATION_DATABASE_URL",
        )
      : databaseUrl,
    dbPoolMax: positiveInteger(environment.DB_POOL_MAX, 20, "DB_POOL_MAX"),
    dbConnectTimeoutMs: positiveInteger(
      environment.DB_CONNECT_TIMEOUT_MS,
      5000,
      "DB_CONNECT_TIMEOUT_MS",
    ),
    dbStatementTimeoutMs: positiveInteger(
      environment.DB_STATEMENT_TIMEOUT_MS,
      5000,
      "DB_STATEMENT_TIMEOUT_MS",
    ),
  };
}

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function requiredUrl(value: string | undefined, name: string): string {
  const normalized = requiredValue(value, name);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function requiredDatabaseUrl(value: string | undefined, name: string): string {
  const normalized = requiredValue(value, name);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname
  ) {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  return normalized;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = 2_147_483_647,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
