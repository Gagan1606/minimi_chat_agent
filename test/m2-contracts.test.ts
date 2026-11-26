import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  AddWorkspaceMemberRequestSchema,
  ChatRequestSchema,
  CreateCompanyRequestSchema,
  CreateWorkspaceRequestSchema,
  ModelContextItemSchema,
  RateLimitEventSchema,
  VectorMetadataSchema,
  parseHistoryQuery,
  parseRateLimitEventQuery,
} from "../src/contracts/v1/index.js";
import {
  ApiErrorEnvelopeSchema,
  apiErrorStatus,
} from "../src/shared/api-errors/index.js";
import {
  buildActorContext,
  canPerform,
  type AuthzAction,
} from "../src/shared/authz-contracts/index.js";
import { decodeCursor, encodeCursor } from "../src/contracts/pagination.js";
import { registerRouteModules } from "../src/shared/route-registration/index.js";
import { openApiDocument } from "../src/contracts/v1/openapi.js";

const personA = randomUUID();
const personB = randomUUID();
const companyA = randomUUID();
const companyB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();

test("chat contract accepts user input but rejects client-supplied authority", () => {
  assert.equal(
    ChatRequestSchema.safeParse({
      scope: "personal",
      message: "hello",
    }).success,
    true,
  );
  for (const untrustedField of ["role", "companyId", "workspaceId"]) {
    assert.equal(
      ChatRequestSchema.safeParse({
        scope: "workspace",
        message: "hello",
        [untrustedField]: randomUUID(),
      }).success,
      false,
      `${untrustedField} must not be accepted from the request body`,
    );
  }
  assert.equal(
    ChatRequestSchema.safeParse({
      scope: "personal",
      message: "x".repeat(10_001),
    }).success,
    false,
  );
});

test("contract schemas set the 50-item pagination maximum and default", () => {
  assert.deepEqual(parseHistoryQuery({ scope: "personal" }), {
    scope: "personal",
    limit: 50,
  });
  assert.equal(
    (() => {
      try {
        parseHistoryQuery({ scope: "personal", limit: "51" });
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
  assert.equal(parseHistoryQuery({ scope: "personal", limit: "5" }).limit, 5);
});

test("model context cannot carry identity or authorization metadata", () => {
  assert.equal(
    ModelContextItemSchema.safeParse({
      content: "A prior message",
      createdAt: new Date().toISOString(),
    }).success,
    true,
  );
  for (const key of [
    "authorId",
    "role",
    "conversationId",
    "messageId",
    "scope",
  ]) {
    assert.equal(
      ModelContextItemSchema.safeParse({
        content: "A prior message",
        createdAt: new Date().toISOString(),
        [key]: randomUUID(),
      }).success,
      false,
      `${key} must not enter model context`,
    );
  }
  assert.equal(
    VectorMetadataSchema.safeParse({
      scope: "workspace",
      scopeId: workspaceA,
      status: "active",
      createdAt: new Date().toISOString(),
      content: "not metadata",
    }).success,
    false,
  );
});

test("error envelope and HTTP status mapping are stable", () => {
  assert.equal(
    ApiErrorEnvelopeSchema.safeParse({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        requestId: randomUUID(),
        retryable: false,
        fieldErrors: [
          { path: "message", code: "too_big", message: "Too long" },
        ],
      },
    }).success,
    true,
  );
  assert.equal(apiErrorStatus("UNAUTHENTICATED"), 401);
  assert.equal(apiErrorStatus("FORBIDDEN"), 403);
  assert.equal(apiErrorStatus("NOT_FOUND"), 404);
  assert.equal(apiErrorStatus("IDEMPOTENCY_CONFLICT"), 409);
  assert.equal(apiErrorStatus("RATE_LIMITED"), 429);
  assert.equal(apiErrorStatus("DEPENDENCY_UNAVAILABLE"), 503);
  assert.equal(apiErrorStatus("DEADLINE_EXCEEDED"), 504);
});

test("pagination cursor is signed, ordered, and bound to the caller scope", () => {
  const secret = randomBytes(32).toString("base64url");
  const scopeBinding = `personal:${personA}`;
  const position = { id: randomUUID(), createdAt: new Date().toISOString() };
  const cursor = encodeCursor(position, scopeBinding, secret);
  assert.deepEqual(decodeCursor(cursor, scopeBinding, secret), position);
  assert.throws(() => decodeCursor(cursor, `personal:${personB}`, secret));
  assert.throws(() =>
    decodeCursor(`${cursor.slice(0, -1)}x`, scopeBinding, secret),
  );
  assert.throws(() =>
    decodeCursor(cursor, scopeBinding, randomBytes(32).toString("hex")),
  );
});

test("actor context derives only from trusted session and membership records", () => {
  const actor = buildActorContext({
    personId: personA,
    platformAdmin: false,
    companyMembership: { companyId: companyA, role: "company_admin" },
    workspaceMembership: {
      companyId: companyA,
      workspaceId: workspaceA,
      role: "member",
    },
  });
  assert.equal(actor.personId, personA);
  assert.equal(actor.companyMembership?.companyId, companyA);
  assert.throws(() =>
    buildActorContext({
      personId: personA,
      platformAdmin: false,
      companyMembership: { companyId: companyA, role: "company_admin" },
      workspaceMembership: {
        companyId: companyB,
        workspaceId: workspaceA,
        role: "workspace_admin",
      },
    }),
  );
});

test("role matrix enforces company/workspace boundaries and admin visibility", () => {
  const companyAdmin = buildActorContext({
    personId: personA,
    platformAdmin: false,
    companyMembership: { companyId: companyA, role: "company_admin" },
  });
  const workspaceAdmin = buildActorContext({
    personId: personB,
    platformAdmin: false,
    companyMembership: { companyId: companyA, role: "member" },
    workspaceMembership: {
      companyId: companyA,
      workspaceId: workspaceA,
      role: "workspace_admin",
    },
  });
  const platformAdmin = buildActorContext({
    personId: randomUUID(),
    platformAdmin: true,
  });
  const allowed = (
    actor: typeof companyAdmin,
    action: AuthzAction,
    target: Parameters<typeof canPerform>[2],
  ) => canPerform(actor, action, target);

  assert.equal(
    allowed(companyAdmin, "company.members.manage", { companyId: companyA }),
    true,
  );
  assert.equal(
    allowed(companyAdmin, "company.members.manage", { companyId: companyB }),
    false,
  );
  assert.equal(
    allowed(companyAdmin, "workspace.use", {
      companyId: companyA,
      workspaceId: workspaceA,
    }),
    false,
  );
  assert.equal(
    allowed(workspaceAdmin, "workspace.members.manage", {
      companyId: companyA,
      workspaceId: workspaceA,
    }),
    true,
  );
  assert.equal(
    allowed(workspaceAdmin, "workspace.members.manage", {
      companyId: companyA,
      workspaceId: workspaceB,
    }),
    false,
  );
  assert.equal(allowed(platformAdmin, "rate_limit_events.read", {}), true);
  assert.equal(allowed(companyAdmin, "rate_limit_events.read", {}), false);
  assert.equal(allowed(workspaceAdmin, "rate_limit_events.read", {}), false);
  assert.equal(allowed(platformAdmin, "conversation.content.read", {}), false);
  assert.equal(
    allowed(platformAdmin, "workspace.use", {
      companyId: companyA,
      workspaceId: workspaceA,
    }),
    false,
  );
});

test("admin request schemas validate IDs and role choices", () => {
  assert.equal(
    CreateCompanyRequestSchema.safeParse({
      name: "Acme",
      companyAdminPersonId: personA,
    }).success,
    true,
  );
  assert.equal(
    CreateWorkspaceRequestSchema.safeParse({ name: "Research" }).success,
    true,
  );
  assert.equal(
    AddWorkspaceMemberRequestSchema.safeParse({ personId: personA }).success,
    true,
  );
  assert.equal(
    AddWorkspaceMemberRequestSchema.safeParse({
      personId: personA,
      role: "workspace_admin",
    }).success,
    false,
  );
  assert.equal(parseRateLimitEventQuery({}).limit, 50);
  assert.throws(() => parseRateLimitEventQuery({ limit: "51" }));
  assert.equal(
    RateLimitEventSchema.safeParse({
      id: randomUUID(),
      rule: "chat.user",
      route: "POST /api/v1/chat",
      requestId: randomUUID(),
      occurredAt: new Date().toISOString(),
      outcome: "throttled",
    }).success,
    true,
  );
});

test("route registration rejects duplicate method and path pairs", () => {
  const modules = [
    {
      name: "health",
      routes: [{ method: "GET" as const, path: "/health/live" }],
    },
    {
      name: "chat",
      routes: [{ method: "POST" as const, path: "/api/v1/chat" }],
    },
  ];
  assert.equal(registerRouteModules(modules).length, 2);
  assert.throws(() =>
    registerRouteModules([
      ...modules,
      {
        name: "duplicate",
        routes: [{ method: "POST" as const, path: "/api/v1/chat" }],
      },
    ]),
  );
});

test("checked-in OpenAPI document matches the Zod schema source", async () => {
  const openApiPath = resolve(process.cwd(), "docs/api/openapi.json");
  const checkedIn = JSON.parse(await readFile(openApiPath, "utf8"));
  assert.deepEqual(checkedIn, openApiDocument);
});
