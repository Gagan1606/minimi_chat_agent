import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import test, { after, before } from "node:test";
import { createAppServer } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { OidcAdapter, OidcIdentity } from "../src/modules/auth/oidc.js";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a real local PostgreSQL database before testing.",
  );
}

const pool = createPool(databaseUrl);
const appBaseUrl = "http://127.0.0.1:3000";
const platformAdmin = {
  issuer: "http://issuer.test/realms/momos",
  subject: "platform-admin-test-subject",
};
let currentIdentity: OidcIdentity;
const oidc: OidcAdapter = {
  begin: async ({ state, nonce, codeVerifier }) =>
    new URL(
      `http://issuer.test/auth?state=${state}&nonce=${nonce}&challenge=${codeVerifier}`,
    ),
  complete: async () => currentIdentity,
};

const config = {
  appBaseUrl,
  oidcRedirectUri: `${appBaseUrl}/auth/oidc/callback`,
  oidcScopes: ["openid", "profile", "email"],
  oidcClientSecret: "test-only-client-secret",
  sessionCookieName: "momos_session",
  oidcTransactionCookieName: "momos_oidc_transaction",
  sessionCookieSecure: false,
  sessionIdleTimeoutSeconds: 3600,
  sessionAbsoluteTimeoutSeconds: 86400,
  platformAdminBootstrap: platformAdmin,
  oidcStartMax: 10,
  oidcStartWindowSeconds: 900,
};

async function listen(
  server?: ReturnType<typeof createAppServer>,
  configOverrides: Partial<typeof config> = {},
) {
  const appConfig = {
    ...config,
    ...configOverrides,
    oidcClientSecret: `test-secret-${randomUUID()}`,
  };
  server ??= createAppServer({ pool, oidc, config: appConfig });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    appConfig,
  };
}

function cookieFrom(response: Response, name: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `expected ${name} cookie`);
  return cookie.split(";", 1)[0]!;
}

function newIdentity(overrides: Partial<OidcIdentity> = {}): OidcIdentity {
  return {
    issuer: platformAdmin.issuer,
    subject: `subject-${crypto.randomUUID()}`,
    email: `user-${crypto.randomUUID()}@example.test`,
    name: "Momos Test User",
    amr: ["pwd", "otp"],
    ...overrides,
  };
}

before(async () => {
  await runMigrations(pool);
});

after(async () => {
  await pool.end();
});

test("migration runner is idempotent and records a checksum", async () => {
  await runMigrations(pool);
  const result = await pool.query<{ count: string; checksum_length: number }>(
    "SELECT count(*)::text AS count, max(length(checksum)) AS checksum_length FROM momos_migration WHERE name = $1",
    ["0001_identity_session.sql"],
  );
  assert.equal(result.rows[0]?.count, "1");
  assert.equal(result.rows[0]?.checksum_length, 64);
});

test("live health endpoint is public and returns a request ID", async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/health/live`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("x-request-id") ?? "",
      /^[0-9a-f-]{36}$/i,
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("traceparent"));
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("readiness succeeds with PostgreSQL and fails against an unavailable real server", async () => {
  const live = await listen();
  const ready = await fetch(`${live.baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });
  live.server.close();
  await once(live.server, "close");

  const unavailablePool = new Pool({
    connectionString: databaseUrl.replace(/:\d+\//, ":1/"),
    connectionTimeoutMillis: 100,
  });
  const unavailable = await listen(
    createAppServer({ pool: unavailablePool, oidc, config }),
  );
  try {
    const response = await fetch(`${unavailable.baseUrl}/health/ready`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        requestId: string;
        retryable: boolean;
      };
    };
    assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(body.error.message, "Service not ready");
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(body.error.retryable, true);
  } finally {
    unavailable.server.close();
    await once(unavailable.server, "close");
    await unavailablePool.end();
  }
});

test("OIDC start validates local return paths and persists a one-time transaction", async () => {
  const { server, baseUrl } = await listen();
  try {
    const invalid = await fetch(
      `${baseUrl}/auth/oidc/start?return_to=${encodeURIComponent("https://evil.test")}`,
      { redirect: "manual" },
    );
    assert.equal(invalid.status, 400);

    const response = await fetch(
      `${baseUrl}/auth/oidc/start?return_to=%2Fchat`,
      {
        redirect: "manual",
      },
    );
    assert.equal(response.status, 302);
    assert.match(
      response.headers.get("location") ?? "",
      /^http:\/\/issuer\.test\/auth/,
    );
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const state = new URL(response.headers.get("location")!).searchParams.get(
      "state",
    );
    assert.ok(state);
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM oidc_transaction WHERE state_hash = $1",
      [createHashForTest(state)],
    );
    assert.equal(result.rows[0]?.count, "1");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("health route rejects unsupported methods", async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/health/live`, { method: "POST" });
    assert.equal(response.status, 405);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("OIDC start throttles after the configured IP limit and stores only a keyed hash", async () => {
  const { server, baseUrl, appConfig } = await listen();
  try {
    for (let attempt = 0; attempt < config.oidcStartMax; attempt += 1) {
      const response = await fetch(`${baseUrl}/auth/oidc/start`, {
        redirect: "manual",
      });
      assert.equal(response.status, 302);
    }

    const limited = await fetch(`${baseUrl}/auth/oidc/start`, {
      redirect: "manual",
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);

    const hashedAddress = createHmac("sha256", appConfig.oidcClientSecret)
      .update("127.0.0.1")
      .digest("hex");
    const bucket = await pool.query<{ request_count: number }>(
      "SELECT request_count FROM auth_rate_limit_bucket WHERE key_hash = $1",
      [hashedAddress],
    );
    assert.equal(bucket.rows[0]?.request_count, config.oidcStartMax + 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("OIDC callback rejects missing state without creating a person or session", async () => {
  const beforeCounts = await pool.query<{ people: string; sessions: string }>(
    "SELECT (SELECT count(*) FROM person)::text AS people, (SELECT count(*) FROM session)::text AS sessions",
  );
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(
      `${baseUrl}/auth/oidc/callback?code=untrusted&state=missing`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    const afterCounts = await pool.query<{ people: string; sessions: string }>(
      "SELECT (SELECT count(*) FROM person)::text AS people, (SELECT count(*) FROM session)::text AS sessions",
    );
    assert.deepEqual(afterCounts.rows, beforeCounts.rows);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("OIDC callback rejects a Platform Admin token without MFA", async () => {
  const bootstrap = {
    issuer: platformAdmin.issuer,
    subject: `platform-admin-mfa-denied-${randomUUID()}`,
  };
  currentIdentity = newIdentity({
    issuer: bootstrap.issuer,
    subject: bootstrap.subject,
    amr: ["pwd"],
  });
  const { server, baseUrl } = await listen(undefined, {
    platformAdminBootstrap: bootstrap,
  });
  try {
    const started = await fetch(`${baseUrl}/auth/oidc/start`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    );
    const transactionCookie = cookieFrom(
      started,
      config.oidcTransactionCookieName,
    );
    const response = await fetch(
      `${baseUrl}/auth/oidc/callback?code=valid&state=${state}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(response.status, 403);
    const sessions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session WHERE person_id IN (SELECT person_id FROM auth_identity WHERE issuer = $1 AND subject = $2)",
      [bootstrap.issuer, bootstrap.subject],
    );
    assert.equal(sessions.rows[0]?.count, "0");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("successful OIDC callback persists identity and session and permits session read", async () => {
  const bootstrap = {
    issuer: platformAdmin.issuer,
    subject: `platform-admin-mfa-accepted-${randomUUID()}`,
  };
  currentIdentity = newIdentity({
    issuer: bootstrap.issuer,
    subject: bootstrap.subject,
    amr: ["pwd", "otp"],
  });
  const { server, baseUrl } = await listen(undefined, {
    platformAdminBootstrap: bootstrap,
  });
  try {
    const started = await fetch(
      `${baseUrl}/auth/oidc/start?return_to=%2Fchat`,
      {
        redirect: "manual",
      },
    );
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    );
    assert.ok(state);
    const transactionCookie = cookieFrom(
      started,
      config.oidcTransactionCookieName,
    );
    const callback = await fetch(
      `${baseUrl}/auth/oidc/callback?code=valid&state=${state}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${appBaseUrl}/chat`);
    const sessionCookie = cookieFrom(callback, config.sessionCookieName);
    const identity = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_identity WHERE issuer = $1 AND subject = $2",
      [bootstrap.issuer, bootstrap.subject],
    );
    const sessionCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session s JOIN auth_identity i USING (person_id) WHERE i.issuer = $1 AND i.subject = $2 AND s.revoked_at IS NULL",
      [bootstrap.issuer, bootstrap.subject],
    );
    assert.equal(identity.rows[0]?.count, "1");
    assert.equal(sessionCount.rows[0]?.count, "1");

    const response = await fetch(`${baseUrl}/auth/session`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(response.status, 200);
    const session = (await response.json()) as {
      authenticated: boolean;
      role: string;
      csrfToken: string;
    };
    assert.equal(session.authenticated, true);
    assert.equal(session.role, "platform_admin");
    assert.ok(session.csrfToken.length >= 32);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("session and logout reject unauthenticated requests; logout requires bound CSRF token", async () => {
  const { server, baseUrl } = await listen();
  try {
    const sessionResponse = await fetch(`${baseUrl}/auth/session`);
    assert.equal(sessionResponse.status, 401);

    const started = await fetch(`${baseUrl}/auth/oidc/start`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    );
    const transactionCookie = cookieFrom(
      started,
      config.oidcTransactionCookieName,
    );
    currentIdentity = newIdentity();
    const callback = await fetch(
      `${baseUrl}/auth/oidc/callback?code=valid&state=${state}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    const sessionCookie = cookieFrom(callback, config.sessionCookieName);
    const sessionResponseAuthenticated = await fetch(
      `${baseUrl}/auth/session`,
      {
        headers: { cookie: sessionCookie },
      },
    );
    const session = (await sessionResponseAuthenticated.json()) as {
      csrfToken: string;
    };

    const noSession = await fetch(`${baseUrl}/auth/logout`, { method: "POST" });
    assert.equal(noSession.status, 401);
    const badCsrf = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: sessionCookie, "x-csrf-token": "wrong" },
    });
    assert.equal(badCsrf.status, 403);
    const beforeLogout = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session WHERE revoked_at IS NULL AND token_hash = $1",
      [createHashForTest(sessionCookie.split("=", 2)[1]!)],
    );
    assert.equal(beforeLogout.rows[0]?.count, "1");

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "x-csrf-token": session.csrfToken,
      },
    });
    assert.equal(logout.status, 204);
    const afterLogout = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session WHERE revoked_at IS NOT NULL AND token_hash = $1",
      [createHashForTest(sessionCookie.split("=", 2)[1]!)],
    );
    assert.equal(afterLogout.rows[0]?.count, "1");
  } finally {
    server.close();
    await once(server, "close");
  }
});

function createHashForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
