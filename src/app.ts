import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Pool } from "pg";
import { withTransaction } from "./db/transactions.js";
import { createRequestTraceContext } from "./observability/trace-context.js";
import { recordRequestMetric } from "./observability/request-metrics.js";
import type { OidcAdapter, OidcIdentity } from "./modules/auth/oidc.js";
import { createTenancyHandler } from "./modules/tenancy/routes.js";
import { handlePersonalChatRoute } from "./modules/chat/personal/routes.js";
import type { ModelProvider } from "./providers/types.js";
import {
  createAdminOperationsHandler,
  type AdminOperationsStatus,
} from "./modules/admin/operations/routes.js";
import type { SourcedAnswerProvider } from "./modules/chat/answers/service.js";
import type { PersonalHistoryRetriever } from "./modules/retrieval/history.js";
import { handleWorkspaceChatRoute } from "./modules/chat/workspace/routes.js";
import type { createWorkspaceHistoryRetriever } from "./modules/retrieval/workspace-scope/index.js";

export interface AppConfig {
  appBaseUrl: string;
  oidcRedirectUri: string;
  oidcScopes: string[];
  oidcMfaAcrValues?: string[];
  oidcClientSecret: string;
  sessionCookieName: string;
  oidcTransactionCookieName: string;
  sessionCookieSecure: boolean;
  sessionIdleTimeoutSeconds: number;
  sessionAbsoluteTimeoutSeconds: number;
  platformAdminBootstrap: { issuer: string; subject: string };
  oidcStartMax: number;
  oidcStartWindowSeconds: number;
}

export interface AppDependencies {
  pool: Pool;
  oidc: OidcAdapter;
  config: AppConfig;
  model?: ModelProvider;
  answerProvider?: SourcedAnswerProvider;
  historyRetriever?: PersonalHistoryRetriever;
  workspaceHistoryRetriever?: ReturnType<
    typeof createWorkspaceHistoryRetriever
  >;
  adminStatus?: AdminOperationsStatus;
}

interface OidcTransaction {
  nonce: string;
  code_verifier: string;
  browser_binding_hash: string;
  return_to: string;
}

const OIDC_TRANSACTION_TTL_SECONDS = 600;

export function createAppServer(dependencies: AppDependencies): Server {
  const { config } = dependencies;
  const featureSecret = createHash("sha256")
    .update(`${config.oidcClientSecret}:feature-signing`)
    .digest("hex");
  const tenancyHandler = createTenancyHandler({
    pool: dependencies.pool,
    sessionCookieName: config.sessionCookieName,
    rateLimitSecret: featureSecret,
  });
  const adminOperationsHandler = createAdminOperationsHandler({
    pool: dependencies.pool,
    sessionCookieName: config.sessionCookieName,
    cursorSigningSecret: featureSecret,
    status: dependencies.adminStatus ?? {
      model: "not_configured",
      webSearch: "not_configured",
      embeddings: "not_configured",
      vectorStore: "not_configured",
      backup: "not_reported",
    },
  });
  return createServer((request, response) => {
    const requestId = randomUUID();
    const incomingTraceparent = request.headers.traceparent;
    const trace = createRequestTraceContext(
      typeof incomingTraceparent === "string" ? incomingTraceparent : undefined,
    );
    const startedAt = performance.now();
    const url = new URL(request.url ?? "/", config.appBaseUrl);
    const route = routeName(url.pathname);
    applySecurityHeaders(response, config.sessionCookieSecure);
    if (url.pathname.startsWith("/auth/")) {
      response.setHeader("cache-control", "no-store, private");
    }
    response.setHeader("x-request-id", requestId);
    response.setHeader("traceparent", trace.traceparent);

    void dispatch(
      request,
      response,
      url,
      requestId,
      dependencies,
      tenancyHandler,
      adminOperationsHandler,
    )
      .catch(() => {
        if (!response.headersSent) {
          sendError(
            response,
            503,
            "DEPENDENCY_UNAVAILABLE",
            "Service unavailable",
            requestId,
            true,
          );
        } else {
          response.destroy();
        }
      })
      .finally(() => {
        const durationMs = Math.max(0, performance.now() - startedAt);
        const status = response.statusCode;
        recordRequestMetric(
          request.method ?? "UNKNOWN",
          route,
          status,
          durationMs,
        );
        process.stdout.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: status >= 500 ? "error" : "info",
            requestId,
            traceId: trace.traceId,
            spanId: trace.spanId,
            method: request.method ?? "UNKNOWN",
            route,
            status,
            durationMs: Math.round(durationMs * 100) / 100,
            tenantId: null,
          })}\n`,
        );
      });
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  url: URL,
  requestId: string,
  dependencies: AppDependencies,
  tenancyHandler: ReturnType<typeof createTenancyHandler>,
  adminOperationsHandler: ReturnType<typeof createAdminOperationsHandler>,
): Promise<void> {
  const { pool, oidc, config } = dependencies;
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/health/live") {
    if (method !== "GET") return methodNotAllowed(response, requestId);
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (path === "/health/ready") {
    if (method !== "GET") return methodNotAllowed(response, requestId);
    try {
      await pool.query("SELECT 1");
      sendJson(response, 200, { status: "ready" });
    } catch {
      sendError(
        response,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Service not ready",
        requestId,
        true,
      );
    }
    return;
  }

  if (path === "/auth/oidc/start") {
    if (method !== "GET") return methodNotAllowed(response, requestId);
    const remoteAddress = normalizedRemoteAddress(request.socket.remoteAddress);
    const limit = await reserveSignInAttempt(pool, remoteAddress, config);
    if (!limit.allowed) {
      response.setHeader("retry-after", String(limit.retryAfterSeconds));
      sendError(
        response,
        429,
        "RATE_LIMITED",
        "Sign-in temporarily unavailable",
        requestId,
        true,
      );
      return;
    }

    const returnTo = validateReturnTo(
      url.searchParams.get("return_to"),
      config.appBaseUrl,
    );
    if (!returnTo) {
      sendError(
        response,
        400,
        "INVALID_INPUT",
        "Invalid return path",
        requestId,
        false,
      );
      return;
    }

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const browserBinding = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO oidc_transaction
        (state_hash, nonce, code_verifier, browser_binding_hash, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`,
      [
        sha256(state),
        nonce,
        codeVerifier,
        sha256(browserBinding),
        returnTo,
        OIDC_TRANSACTION_TTL_SECONDS,
      ],
    );

    const authorizationUrl = await oidc.begin({
      state,
      nonce,
      codeVerifier,
      redirectUri: config.oidcRedirectUri,
      scopes: config.oidcScopes,
    });
    response.setHeader(
      "set-cookie",
      cookie(config.oidcTransactionCookieName, browserBinding, {
        secure: config.sessionCookieSecure,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: OIDC_TRANSACTION_TTL_SECONDS,
      }),
    );
    response.writeHead(302, { location: authorizationUrl.toString() });
    response.end();
    return;
  }

  if (path === "/auth/oidc/callback") {
    if (method !== "GET") return methodNotAllowed(response, requestId);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const browserBinding = readCookie(
      request,
      config.oidcTransactionCookieName,
    );
    if (!state || !code || !browserBinding) {
      sendError(
        response,
        400,
        "INVALID_AUTH_TRANSACTION",
        "Sign-in could not be completed",
        requestId,
        false,
      );
      return;
    }

    const transaction = await consumeOidcTransaction(
      pool,
      state,
      browserBinding,
    );
    if (!transaction) {
      sendError(
        response,
        400,
        "INVALID_AUTH_TRANSACTION",
        "Sign-in could not be completed",
        requestId,
        false,
      );
      return;
    }

    let identity: OidcIdentity;
    try {
      identity = await oidc.complete({
        callbackUrl: new URL(request.url ?? "/", config.appBaseUrl),
        state,
        nonce: transaction.nonce,
        codeVerifier: transaction.code_verifier,
      });
    } catch {
      clearOidcCookie(response, config);
      sendError(
        response,
        401,
        "AUTHENTICATION_FAILED",
        "Sign-in could not be verified",
        requestId,
        false,
      );
      return;
    }

    const isPlatformAdmin =
      identity.issuer === config.platformAdminBootstrap.issuer &&
      identity.subject === config.platformAdminBootstrap.subject;
    const mfaVerified = hasMfa(identity, config.oidcMfaAcrValues ?? []);
    if (isPlatformAdmin && !mfaVerified) {
      clearOidcCookie(response, config);
      sendError(
        response,
        403,
        "MFA_REQUIRED",
        "Platform Admin sign-in requires MFA",
        requestId,
        false,
      );
      return;
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    await withTransaction(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [identity.issuer, identity.subject],
      );
      const existing = await client.query<{ person_id: string }>(
        "SELECT person_id FROM auth_identity WHERE issuer = $1 AND subject = $2 FOR UPDATE",
        [identity.issuer, identity.subject],
      );
      let personId = existing.rows[0]?.person_id;
      if (!personId) {
        personId = randomUUID();
        await client.query(
          "INSERT INTO person (id, email, display_name) VALUES ($1, $2, $3)",
          [personId, identity.email ?? null, identity.name ?? null],
        );
        await client.query(
          `INSERT INTO auth_identity (id, person_id, issuer, subject, email, display_name, amr)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            personId,
            identity.issuer,
            identity.subject,
            identity.email ?? null,
            identity.name ?? null,
            identity.amr,
          ],
        );
      } else {
        await client.query(
          "UPDATE auth_identity SET email = $3, display_name = $4, amr = $5 WHERE issuer = $1 AND subject = $2",
          [
            identity.issuer,
            identity.subject,
            identity.email ?? null,
            identity.name ?? null,
            identity.amr,
          ],
        );
      }
      await client.query(
        `INSERT INTO session
          (token_hash, person_id, csrf_token_hash, platform_admin, mfa_verified,
           idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5,
           now() + ($6 * interval '1 second'), now() + ($7 * interval '1 second'))`,
        [
          sha256(sessionToken),
          personId,
          sha256(csrfToken),
          isPlatformAdmin,
          mfaVerified,
          config.sessionIdleTimeoutSeconds,
          config.sessionAbsoluteTimeoutSeconds,
        ],
      );
    });

    clearOidcCookie(response, config);
    appendCookie(
      response,
      cookie(config.sessionCookieName, sessionToken, {
        secure: config.sessionCookieSecure,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: config.sessionAbsoluteTimeoutSeconds,
      }),
    );
    response.writeHead(302, {
      location: new URL(transaction.return_to, config.appBaseUrl).toString(),
    });
    response.end();
    return;
  }

  if (path === "/auth/session") {
    if (method !== "GET") return methodNotAllowed(response, requestId);
    const token = readCookie(request, config.sessionCookieName);
    if (!token) {
      sendError(
        response,
        401,
        "UNAUTHENTICATED",
        "Sign-in required",
        requestId,
        false,
      );
      return;
    }
    const csrfToken = randomBytes(32).toString("base64url");
    const result = await pool.query<{ platform_admin: boolean }>(
      `UPDATE session
       SET csrf_token_hash = $2,
           last_seen_at = now(),
           idle_expires_at = LEAST(now() + ($3 * interval '1 second'), absolute_expires_at)
       WHERE token_hash = $1 AND revoked_at IS NULL
         AND idle_expires_at > now() AND absolute_expires_at > now()
       RETURNING platform_admin`,
      [sha256(token), sha256(csrfToken), config.sessionIdleTimeoutSeconds],
    );
    const session = result.rows[0];
    if (!session) {
      sendError(
        response,
        401,
        "UNAUTHENTICATED",
        "Sign-in required",
        requestId,
        false,
      );
      return;
    }
    sendJson(response, 200, {
      authenticated: true,
      role: session.platform_admin ? "platform_admin" : "member",
      csrfToken,
    });
    return;
  }

  if (path === "/auth/logout") {
    if (method !== "POST") return methodNotAllowed(response, requestId);
    const token = readCookie(request, config.sessionCookieName);
    const csrfToken = request.headers["x-csrf-token"];
    if (!token) {
      sendError(
        response,
        401,
        "UNAUTHENTICATED",
        "Sign-in required",
        requestId,
        false,
      );
      return;
    }
    if (typeof csrfToken !== "string") {
      sendError(
        response,
        403,
        "CSRF_FAILED",
        "Request could not be verified",
        requestId,
        false,
      );
      return;
    }
    const result = await pool.query<{ csrf_token_hash: string }>(
      `SELECT csrf_token_hash FROM session
       WHERE token_hash = $1 AND revoked_at IS NULL
         AND idle_expires_at > now() AND absolute_expires_at > now()`,
      [sha256(token)],
    );
    const storedCsrfHash = result.rows[0]?.csrf_token_hash;
    if (!storedCsrfHash || !safeHashEqual(storedCsrfHash, sha256(csrfToken))) {
      sendError(
        response,
        403,
        "CSRF_FAILED",
        "Request could not be verified",
        requestId,
        false,
      );
      return;
    }
    await pool.query(
      "UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
      [sha256(token)],
    );
    response.setHeader(
      "set-cookie",
      cookie(config.sessionCookieName, "", {
        secure: config.sessionCookieSecure,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 0,
      }),
    );
    response.writeHead(204);
    response.end();
    return;
  }

  if (await serveFeatureAsset(path, response, requestId)) return;
  if (await tenancyHandler(request, response, requestId)) return;
  if (await adminOperationsHandler(request, response, url, requestId)) return;
  if (dependencies.model) {
    const featureSecret = createHash("sha256")
      .update(`${config.oidcClientSecret}:feature-signing`)
      .digest("hex");
    const chatDependencies = {
      pool,
      model: dependencies.model,
      ...(dependencies.answerProvider
        ? { answerProvider: dependencies.answerProvider }
        : {}),
      sessionCookieName: config.sessionCookieName,
      modelTimeoutMs: positiveEnvironmentInteger("MODEL_TIMEOUT_MS", 10_000),
    };
    if (
      await handleWorkspaceChatRoute(request, response, url, requestId, {
        ...chatDependencies,
        ...(dependencies.workspaceHistoryRetriever
          ? { retriever: dependencies.workspaceHistoryRetriever }
          : {}),
      })
    )
      return;
    const handled = await handlePersonalChatRoute(
      request,
      response,
      url,
      requestId,
      {
        ...chatDependencies,
        ...(dependencies.answerProvider
          ? { answerProvider: dependencies.answerProvider }
          : {}),
        ...(dependencies.historyRetriever
          ? { historyRetriever: dependencies.historyRetriever }
          : {}),
        sessionCookieName: config.sessionCookieName,
        cursorSigningSecret: featureSecret,
        rateLimitSecret: featureSecret,
        sessionCookieSecure: config.sessionCookieSecure,
        chatLimit: positiveEnvironmentInteger("RATE_LIMIT_CHAT_MAX", 30),
        chatWindowSeconds: positiveEnvironmentInteger(
          "RATE_LIMIT_CHAT_WINDOW_SECONDS",
          60,
        ),
        readLimit: positiveEnvironmentInteger("RATE_LIMIT_READ_MAX", 120),
        readWindowSeconds: positiveEnvironmentInteger(
          "RATE_LIMIT_READ_WINDOW_SECONDS",
          60,
        ),
        deleteLimit: positiveEnvironmentInteger("RATE_LIMIT_DELETE_MAX", 10),
        deleteWindowSeconds: positiveEnvironmentInteger(
          "RATE_LIMIT_DELETE_WINDOW_SECONDS",
          3600,
        ),
      },
    );
    if (handled) return;
  }

  sendError(response, 404, "NOT_FOUND", "Route not found", requestId, false);
}

async function serveFeatureAsset(
  path: string,
  response: ServerResponse<IncomingMessage>,
  requestId: string,
): Promise<boolean> {
  const assets: Record<string, [string, string]> = {
    "/workspace-chat": [
      "web/src/features/workspace-chat/index.html",
      "text/html; charset=utf-8",
    ],
    "/workspace-chat/chat.css": [
      "web/src/features/workspace-chat/chat.css",
      "text/css; charset=utf-8",
    ],
    "/workspace-chat/chat.js": [
      "web/src/features/workspace-chat/chat.js",
      "text/javascript; charset=utf-8",
    ],
    "/company-admin": [
      "web/src/features/company-admin/index.html",
      "text/html; charset=utf-8",
    ],
    "/company-admin/admin.css": [
      "web/src/features/company-admin/admin.css",
      "text/css; charset=utf-8",
    ],
    "/company-admin/admin.js": [
      "web/src/features/company-admin/admin.js",
      "text/javascript; charset=utf-8",
    ],
    "/workspace-admin": [
      "web/src/features/workspace-admin/index.html",
      "text/html; charset=utf-8",
    ],
    "/workspace-admin/admin.css": [
      "web/src/features/workspace-admin/admin.css",
      "text/css; charset=utf-8",
    ],
    "/workspace-admin/admin.js": [
      "web/src/features/workspace-admin/admin.js",
      "text/javascript; charset=utf-8",
    ],
    "/personal-chat": [
      "web/src/features/personal-chat/index.html",
      "text/html; charset=utf-8",
    ],
    "/personal-chat/personal-chat.css": [
      "web/src/features/personal-chat/personal-chat.css",
      "text/css; charset=utf-8",
    ],
    "/personal-chat/personal-chat.js": [
      "web/src/features/personal-chat/personal-chat.js",
      "text/javascript; charset=utf-8",
    ],
    "/admin/platform": [
      "web/src/features/admin/platform.html",
      "text/html; charset=utf-8",
    ],
    "/admin/company": [
      "web/src/features/admin/company.html",
      "text/html; charset=utf-8",
    ],
    "/admin/workspace": [
      "web/src/features/admin/workspace.html",
      "text/html; charset=utf-8",
    ],
    "/admin/admin.css": [
      "web/src/features/admin/admin.css",
      "text/css; charset=utf-8",
    ],
    "/admin/admin.js": [
      "web/src/features/admin/admin.js",
      "text/javascript; charset=utf-8",
    ],
  };
  const asset = assets[path];
  if (!asset) return false;
  try {
    const contents = await readFile(resolve(process.cwd(), asset[0]));
    response.writeHead(200, {
      "content-type": asset[1],
      "cache-control": "no-cache",
    });
    response.end(contents);
  } catch {
    sendError(
      response,
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Feature asset unavailable",
      requestId,
      true,
    );
  }
  return true;
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function consumeOidcTransaction(
  pool: Pool,
  state: string,
  browserBinding: string,
): Promise<OidcTransaction | undefined> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<OidcTransaction>(
      `SELECT nonce, code_verifier, browser_binding_hash, return_to
       FROM oidc_transaction
       WHERE state_hash = $1 AND expires_at > now() AND consumed_at IS NULL
       FOR UPDATE`,
      [sha256(state)],
    );
    const transaction = result.rows[0];
    if (
      !transaction ||
      !safeHashEqual(transaction.browser_binding_hash, sha256(browserBinding))
    ) {
      return undefined;
    }
    await client.query(
      "UPDATE oidc_transaction SET consumed_at = now() WHERE state_hash = $1",
      [sha256(state)],
    );
    return transaction;
  });
}

async function reserveSignInAttempt(
  pool: Pool,
  remoteAddress: string,
  config: AppConfig,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const keyHash = createHmac("sha256", config.oidcClientSecret)
    .update(remoteAddress)
    .digest("hex");
  await pool.query(
    "DELETE FROM auth_rate_limit_bucket WHERE expires_at <= now()",
  );
  const result = await pool.query<{
    request_count: number;
    retry_after_seconds: number;
  }>(
    `INSERT INTO auth_rate_limit_bucket
       (key_hash, window_started_at, request_count, expires_at)
     VALUES ($1, now(), 1, now() + ($2::integer * interval '1 second'))
     ON CONFLICT (key_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN auth_rate_limit_bucket.expires_at <= now() THEN now()
         ELSE auth_rate_limit_bucket.window_started_at
       END,
       request_count = CASE
         WHEN auth_rate_limit_bucket.expires_at <= now() THEN 1
         ELSE auth_rate_limit_bucket.request_count + 1
       END,
       expires_at = CASE
         WHEN auth_rate_limit_bucket.expires_at <= now()
           THEN now() + ($2::integer * interval '1 second')
         ELSE auth_rate_limit_bucket.expires_at
       END
     RETURNING request_count,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM
         (window_started_at + ($2::integer * interval '1 second') - now()))))::integer
         AS retry_after_seconds`,
    [keyHash, config.oidcStartWindowSeconds],
  );
  const bucket = result.rows[0];
  if (!bucket) throw new Error("Rate-limit bucket was not returned");
  return {
    allowed: bucket.request_count <= config.oidcStartMax,
    retryAfterSeconds: bucket.retry_after_seconds,
  };
}

function hasMfa(identity: OidcIdentity, acceptedAcrValues: string[]): boolean {
  return (
    identity.amr.some((method) =>
      ["mfa", "otp"].includes(method.toLowerCase()),
    ) ||
    (identity.acr !== undefined && acceptedAcrValues.includes(identity.acr))
  );
}

function validateReturnTo(
  value: string | null,
  appBaseUrl: string,
): string | undefined {
  const returnTo = value ?? "/";
  if (
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//") ||
    /[\\\r\n]/.test(returnTo)
  ) {
    return undefined;
  }
  const resolved = new URL(returnTo, appBaseUrl);
  return resolved.origin === new URL(appBaseUrl).origin
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : undefined;
}

function routeName(path: string): string {
  return path.startsWith("/auth/oidc/") ? "/auth/oidc/:action" : path;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRemoteAddress(remoteAddress: string | undefined): string {
  if (!remoteAddress) return "unknown";
  return remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readCookie(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookieValue of cookies) {
    const [cookieName, ...valueParts] = cookieValue.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return undefined;
}

function cookie(
  name: string,
  value: string,
  options: {
    secure: boolean;
    httpOnly: boolean;
    sameSite: "Lax";
    maxAge: number;
  },
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
    `SameSite=${options.sameSite}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function appendCookie(
  response: ServerResponse<IncomingMessage>,
  value: string,
): void {
  const current = response.getHeader("set-cookie");
  response.setHeader("set-cookie", [
    ...(Array.isArray(current) ? current : current ? [String(current)] : []),
    value,
  ]);
}

function clearOidcCookie(
  response: ServerResponse<IncomingMessage>,
  config: AppConfig,
): void {
  response.setHeader(
    "set-cookie",
    cookie(config.oidcTransactionCookieName, "", {
      secure: config.sessionCookieSecure,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 0,
    }),
  );
}

function applySecurityHeaders(
  response: ServerResponse<IncomingMessage>,
  secureCookie: boolean,
): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  if (secureCookie)
    response.setHeader(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse<IncomingMessage>,
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable: boolean,
): void {
  sendJson(response, status, {
    error: { code, message, requestId, retryable },
  });
}

function methodNotAllowed(
  response: ServerResponse<IncomingMessage>,
  requestId: string,
): void {
  sendError(
    response,
    405,
    "METHOD_NOT_ALLOWED",
    "Method not allowed",
    requestId,
    false,
  );
}
