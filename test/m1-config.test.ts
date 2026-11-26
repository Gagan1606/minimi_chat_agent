import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/env.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    OIDC_ISSUER_URL: "http://localhost:8080/realms/momos-demo",
    OIDC_CLIENT_ID: "momos-test",
    OIDC_CLIENT_SECRET: "test-only-secret",
    OIDC_REDIRECT_URI: "http://localhost:3000/auth/oidc/callback",
    PLATFORM_ADMIN_BOOTSTRAP_ISSUER: "http://localhost:8080/realms/momos-demo",
    PLATFORM_ADMIN_BOOTSTRAP_SUBJECT: "subject-test",
    DATABASE_URL: "postgresql://momos:momos@localhost:5432/momos",
  };
}

test("configuration requires valid OIDC, database, and bootstrap identity settings", () => {
  const environment = validEnvironment();
  environment.OIDC_CLIENT_SECRET = "";
  assert.throws(
    () => loadConfig(environment),
    /OIDC_CLIENT_SECRET is required/,
  );
});

test("production configuration rejects insecure origins and cookies", () => {
  const environment = validEnvironment();
  environment.NODE_ENV = "production";
  assert.throws(() => loadConfig(environment), /HTTPS/);

  environment.APP_BASE_URL = "https://momos.example.com";
  environment.OIDC_REDIRECT_URI =
    "https://momos.example.com/auth/oidc/callback";
  environment.OIDC_ISSUER_URL = "https://identity.example.com/realms/momos";
  environment.PLATFORM_ADMIN_BOOTSTRAP_ISSUER = environment.OIDC_ISSUER_URL;
  environment.SESSION_COOKIE_SECURE = "false";
  assert.throws(() => loadConfig(environment), /SESSION_COOKIE_SECURE/);
});
