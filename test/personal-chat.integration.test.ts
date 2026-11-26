import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import test, {
  after,
  before,
  type TestContext as NodeTestContext,
} from "node:test";
import type { ModelProvider } from "../src/providers/types.js";
import { handlePersonalChatRoute } from "../src/modules/chat/personal/routes.js";
import type { PersonalChatDependencies } from "../src/modules/chat/personal/types.js";
import { runMigrations } from "../src/db/migrate.js";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://momos:momos@127.0.0.1:15432/momos";
const pool = new Pool({ connectionString: databaseUrl });
const appBaseUrl = "http://127.0.0.1";
const activeContexts = new Set<TestContext>();

interface TestUser {
  personId: string;
  sessionToken: string;
  csrfToken: string;
}

class TestModel implements ModelProvider {
  readonly prompts: Array<{ prompt: string; systemInstruction?: string }> = [];
  private responder: (
    prompt: string,
    systemInstruction?: string,
  ) => Promise<string> = async () => `answer-${this.prompts.length}`;

  setResponder(
    responder: (prompt: string, systemInstruction?: string) => Promise<string>,
  ): void {
    this.responder = responder;
  }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    this.prompts.push({
      prompt,
      ...(systemInstruction === undefined ? {} : { systemInstruction }),
    });
    return this.responder(prompt, systemInstruction);
  }
}

interface TestContext {
  server: Server;
  baseUrl: string;
  deps: PersonalChatDependencies;
  model: TestModel;
  users: TestUser[];
  addUser(): Promise<TestUser>;
  close(): Promise<void>;
  headers(
    user: TestUser,
    extra?: Record<string, string>,
  ): Record<string, string>;
}

before(async () => {
  await runMigrations(pool);
});

after(async () => {
  for (const context of activeContexts) await context.close();
  await pool.end();
});

async function setup(
  t: NodeTestContext,
  options: {
    chatLimit?: number;
    readLimit?: number;
    deleteLimit?: number;
    modelTimeoutMs?: number;
  } = {},
): Promise<TestContext> {
  const model = new TestModel();
  const deps: PersonalChatDependencies = {
    pool,
    model,
    sessionCookieName: "momos_session",
    cursorSigningSecret: randomBytes(32).toString("base64url"),
    rateLimitSecret: randomBytes(32).toString("base64url"),
    sessionCookieSecure: false,
    modelTimeoutMs: options.modelTimeoutMs ?? 1_000,
    chatLimit: options.chatLimit ?? 30,
    chatWindowSeconds: 60,
    readLimit: options.readLimit ?? 120,
    readWindowSeconds: 60,
    deleteLimit: options.deleteLimit ?? 10,
    deleteWindowSeconds: 3_600,
  };
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const url = new URL(request.url ?? "/", appBaseUrl);
    void handlePersonalChatRoute(request, response, url, requestId, deps)
      .then((handled) => {
        if (!handled && !response.headersSent) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "NOT_FOUND",
                message: "Route not found",
                requestId,
                retryable: false,
              },
            }),
          );
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Service unavailable",
                requestId,
                retryable: true,
              },
            }),
          );
        }
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const users: TestUser[] = [];
  const context: TestContext = {
    server,
    baseUrl,
    deps,
    model,
    users,
    addUser: async () => {
      const user = await addUser();
      users.push(user);
      return user;
    },
    headers: (user, extra = {}) => ({
      cookie: `${deps.sessionCookieName}=${user.sessionToken}`,
      "x-csrf-token": user.csrfToken,
      ...extra,
    }),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await cleanup(users, deps);
      activeContexts.delete(context);
    },
  };
  activeContexts.add(context);
  t.after(context.close);
  return context;
}

async function addUser(): Promise<TestUser> {
  const personId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO person (id, email, display_name) VALUES ($1, $2, $3)",
    [personId, `m4-${personId}@example.test`, "M4 test user"],
  );
  await pool.query(
    "INSERT INTO auth_identity (id, person_id, issuer, subject) VALUES ($1, $2, $3, $4)",
    [randomUUID(), personId, "https://m4-test.example/issuer", randomUUID()],
  );
  await pool.query(
    `INSERT INTO session
      (token_hash, person_id, csrf_token_hash, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '1 day')`,
    [sha256(sessionToken), personId, sha256(csrfToken)],
  );
  return { personId, sessionToken, csrfToken };
}

async function cleanup(
  users: readonly TestUser[],
  deps: PersonalChatDependencies,
): Promise<void> {
  for (const user of users) {
    await pool.query("DELETE FROM idempotency_record WHERE principal_id = $1", [
      user.personId,
    ]);
    await pool.query("DELETE FROM rate_limit_event WHERE person_id = $1", [
      user.personId,
    ]);
    await pool.query(
      `DELETE FROM citation WHERE assistant_message_id IN (
         SELECT m.id FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.owner_person_id = $1
       )`,
      [user.personId],
    );
    await pool.query(
      `DELETE FROM message WHERE conversation_id IN (
         SELECT id FROM conversation WHERE owner_person_id = $1
       )`,
      [user.personId],
    );
    await pool.query("DELETE FROM conversation WHERE owner_person_id = $1", [
      user.personId,
    ]);
    await pool.query("DELETE FROM session WHERE person_id = $1", [
      user.personId,
    ]);
    await pool.query("DELETE FROM auth_identity WHERE person_id = $1", [
      user.personId,
    ]);
    await pool.query("DELETE FROM person WHERE id = $1", [user.personId]);
    const bucketHashes = [
      "personal.chat",
      "personal.history.read",
      "personal.history.delete",
    ].map((rule) =>
      createHmac("sha256", deps.rateLimitSecret)
        .update(`momos:personal-rate-limit:${rule}:${user.personId}`)
        .digest("hex"),
    );
    await pool.query(
      "DELETE FROM auth_rate_limit_bucket WHERE key_hash = ANY($1::char(64)[])",
      [bucketHashes],
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function postChat(
  context: TestContext,
  user: TestUser,
  body: unknown,
  idempotencyKey = randomUUID(),
): Promise<Response> {
  return fetch(`${context.baseUrl}/api/v1/chat`, {
    method: "POST",
    headers: context.headers(user, {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    }),
    body: JSON.stringify(body),
  });
}

async function postChatRaw(
  context: TestContext,
  user: TestUser,
  body: string,
): Promise<Response> {
  return fetch(`${context.baseUrl}/api/v1/chat`, {
    method: "POST",
    headers: context.headers(user, {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    }),
    body,
  });
}

function getError(body: unknown): {
  code: string;
  requestId: string;
  retryable: boolean;
} {
  assert.ok(typeof body === "object" && body !== null && "error" in body);
  const error = (
    body as { error: { code: string; requestId: string; retryable: boolean } }
  ).error;
  assert.match(error.requestId, /^[0-9a-f-]{36}$/i);
  return error;
}

test("personal chat persists an idempotent user/assistant turn", async (t) => {
  const context = await setup(t);
  const user = await context.addUser();
  const key = randomUUID();
  const payload = { scope: "personal", message: "Hello Momos" };
  const response = await postChat(context, user, payload, key);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    conversationId: string;
    messageId: string;
    answer: string;
    citations: unknown[];
    createdAt: string;
  };
  assert.equal(body.answer, "answer-1");
  assert.deepEqual(body.citations, []);
  assert.ok(body.conversationId);
  assert.ok(body.messageId);
  assert.match(body.createdAt, /Z$/);

  const stored = await pool.query<{
    role: string;
    content: string;
    status: string;
  }>(
    `SELECT m.role, m.content, m.status FROM message m
     JOIN conversation c ON c.id = m.conversation_id
     WHERE c.id = $1 ORDER BY m.created_at, CASE m.role WHEN 'user' THEN 0 ELSE 1 END, m.id`,
    [body.conversationId],
  );
  assert.deepEqual(
    stored.rows.map(({ role, content, status }) => ({ role, content, status })),
    [
      { role: "user", content: payload.message, status: "active" },
      { role: "assistant", content: body.answer, status: "active" },
    ],
  );
  const idempotency = await pool.query<{
    state: string;
    result_resource_id: string;
  }>(
    "SELECT state, result_resource_id FROM idempotency_record WHERE principal_id = $1 AND idempotency_key = $2",
    [user.personId, key],
  );
  assert.deepEqual(idempotency.rows[0], {
    state: "completed",
    result_resource_id: body.messageId,
  });

  const replay = await postChat(context, user, payload, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), body);
  const count = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message m
     JOIN conversation c ON c.id = m.conversation_id WHERE c.id = $1`,
    [body.conversationId],
  );
  assert.equal(count.rows[0]?.count, "2");
  assert.equal(context.model.prompts.length, 1);
});

test("chat rejects invalid payloads, workspace scope, unauthenticated callers, and foreign conversations", async (t) => {
  const context = await setup(t);
  const owner = await context.addUser();
  const other = await context.addUser();

  const invalid = await postChat(context, owner, {
    scope: "personal",
    message: "x".repeat(10_001),
  });
  assert.equal(invalid.status, 422);
  assert.equal(getError(await invalid.json()).code, "VALIDATION_FAILED");
  const invalidPayload = await postChat(context, owner, {
    scope: "personal",
    message: "hello",
    companyId: randomUUID(),
  });
  assert.equal(invalidPayload.status, 422);
  const malformedJson = await postChatRaw(context, owner, "{");
  assert.equal(malformedJson.status, 400);
  assert.equal(getError(await malformedJson.json()).code, "INVALID_REQUEST");

  const unauthenticated = await fetch(`${context.baseUrl}/api/v1/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ scope: "personal", message: "hello" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(getError(await unauthenticated.json()).code, "UNAUTHENTICATED");

  const wrongScope = await postChat(context, owner, {
    scope: "workspace",
    message: "hello",
  });
  assert.equal(wrongScope.status, 403);
  assert.equal(getError(await wrongScope.json()).code, "FORBIDDEN");

  const foreignTurn = await postChat(context, other, {
    scope: "personal",
    message: "private to another person",
  });
  const foreign = (await foreignTurn.json()) as { conversationId: string };
  const foreignCountBefore = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message
     WHERE conversation_id = $1`,
    [foreign.conversationId],
  );
  const crossUser = await postChat(context, owner, {
    scope: "personal",
    conversationId: foreign.conversationId,
    message: "attempt to write into another user's chat",
  });
  assert.equal(crossUser.status, 404);
  assert.equal(getError(await crossUser.json()).code, "NOT_FOUND");
  const foreignCountAfter = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM message WHERE conversation_id = $1",
    [foreign.conversationId],
  );
  assert.deepEqual(foreignCountAfter.rows, foreignCountBefore.rows);
});

test("personal history lists only the owner’s conversations with scope-bound 50-item cursors", async (t) => {
  const context = await setup(t);
  const owner = await context.addUser();
  const other = await context.addUser();
  const created: string[] = [];
  for (const message of [
    "first personal chat",
    "second personal chat",
    "third personal chat",
  ]) {
    const response = await postChat(context, owner, {
      scope: "personal",
      message,
    });
    assert.equal(response.status, 200);
    created.push(
      ((await response.json()) as { conversationId: string }).conversationId,
    );
  }
  const otherResponse = await postChat(context, other, {
    scope: "personal",
    message: "must not appear in owner's list",
  });
  const otherConversation = (await otherResponse.json()) as {
    conversationId: string;
  };
  await postChat(context, other, {
    scope: "personal",
    message: "second private conversation",
  });

  const pageOne = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal&limit=2`,
    { headers: context.headers(owner) },
  );
  assert.equal(pageOne.status, 200);
  const firstPage = (await pageOne.json()) as {
    items: Array<{ id: string; scope: string; title: string }>;
    nextCursor: string | null;
  };
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);
  assert.ok(firstPage.items.every((item) => item.scope === "personal"));
  assert.ok(
    firstPage.items.every(
      (item) => item.id !== otherConversation.conversationId,
    ),
  );
  const pageTwo = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    { headers: context.headers(owner) },
  );
  assert.equal(pageTwo.status, 200);
  const secondPage = (await pageTwo.json()) as {
    items: Array<{ id: string }>;
    nextCursor: string | null;
  };
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(
    new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))
      .size,
    3,
  );
  assert.deepEqual(
    new Set(created),
    new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)),
  );

  const otherCursor = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal&limit=1`,
    { headers: context.headers(other) },
  );
  const otherPage = (await otherCursor.json()) as { nextCursor: string | null };
  assert.ok(otherPage.nextCursor);
  const cursorLeak = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal&limit=1&cursor=${encodeURIComponent(otherPage.nextCursor!)}`,
    { headers: context.headers(owner) },
  );
  assert.equal(cursorLeak.status, 422);
  assert.equal(getError(await cursorLeak.json()).code, "VALIDATION_FAILED");
});

test("history endpoints reject invalid, unauthenticated, workspace, and cross-user reads", async (t) => {
  const context = await setup(t);
  const owner = await context.addUser();
  const other = await context.addUser();
  const response = await postChat(context, owner, {
    scope: "personal",
    message: "only the owner should see this",
  });
  const conversation = (await response.json()) as { conversationId: string };

  const detail = await fetch(
    `${context.baseUrl}/api/v1/conversations/${conversation.conversationId}`,
    { headers: context.headers(owner) },
  );
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(
    detailBody.messages[0]?.content,
    "only the owner should see this",
  );

  const missingAuth = await fetch(
    `${context.baseUrl}/api/v1/conversations/${conversation.conversationId}`,
  );
  assert.equal(missingAuth.status, 401);
  const invalidId = await fetch(
    `${context.baseUrl}/api/v1/conversations/not-a-uuid`,
    {
      headers: context.headers(owner),
    },
  );
  assert.equal(invalidId.status, 422);
  const crossUser = await fetch(
    `${context.baseUrl}/api/v1/conversations/${conversation.conversationId}`,
    { headers: context.headers(other) },
  );
  assert.equal(crossUser.status, 404);
  const wrongScope = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=workspace`,
    { headers: context.headers(owner) },
  );
  assert.equal(wrongScope.status, 403);
  const invalidScope = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=unknown`,
    { headers: context.headers(owner) },
  );
  assert.equal(invalidScope.status, 422);
  const noScope = await fetch(`${context.baseUrl}/api/v1/conversations`, {
    headers: context.headers(owner),
  });
  assert.equal(noScope.status, 422);
  const invalidLimit = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal&limit=51`,
    { headers: context.headers(owner) },
  );
  assert.equal(invalidLimit.status, 422);
  const unauthenticatedList = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal`,
  );
  assert.equal(unauthenticatedList.status, 401);
});

test("single and all-history deletion tombstone only the authenticated owner’s personal messages", async (t) => {
  const context = await setup(t);
  const owner = await context.addUser();
  const other = await context.addUser();
  const ownFirst = await postChat(context, owner, {
    scope: "personal",
    message: "delete this single chat",
  });
  const first = (await ownFirst.json()) as { conversationId: string };
  const ownSecond = await postChat(context, owner, {
    scope: "personal",
    message: "delete this whole history",
  });
  const second = (await ownSecond.json()) as { conversationId: string };
  const otherChat = await postChat(context, other, {
    scope: "personal",
    message: "other user history stays active",
  });
  const foreign = (await otherChat.json()) as { conversationId: string };

  const deleteOne = await fetch(
    `${context.baseUrl}/api/v1/conversations/${first.conversationId}`,
    { method: "DELETE", headers: context.headers(owner) },
  );
  assert.equal(deleteOne.status, 200);
  assert.deepEqual(await deleteOne.json(), {
    id: first.conversationId,
    deleted: true,
  });
  const deletedRows = await pool.query<{
    status: string;
    deleted_at: Date | null;
  }>(
    `SELECT m.status, m.deleted_at FROM message m
     WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id`,
    [first.conversationId],
  );
  assert.equal(deletedRows.rowCount, 2);
  assert.ok(
    deletedRows.rows.every((row) => row.status === "deleted" && row.deleted_at),
  );
  const repeatDelete = await fetch(
    `${context.baseUrl}/api/v1/conversations/${first.conversationId}`,
    { method: "DELETE", headers: context.headers(owner) },
  );
  assert.equal(repeatDelete.status, 200);

  const crossDelete = await fetch(
    `${context.baseUrl}/api/v1/conversations/${foreign.conversationId}`,
    { method: "DELETE", headers: context.headers(owner) },
  );
  assert.equal(crossDelete.status, 404);
  const invalidDelete = await fetch(
    `${context.baseUrl}/api/v1/conversations/not-a-uuid`,
    { method: "DELETE", headers: context.headers(owner) },
  );
  assert.equal(invalidDelete.status, 422);
  const crossDeleteUnauthenticated = await fetch(
    `${context.baseUrl}/api/v1/conversations/${second.conversationId}`,
    { method: "DELETE" },
  );
  assert.equal(crossDeleteUnauthenticated.status, 401);
  const bulkDeleteUnauthenticated = await fetch(
    `${context.baseUrl}/api/v1/me/history`,
    { method: "DELETE" },
  );
  assert.equal(bulkDeleteUnauthenticated.status, 401);
  const badCsrf = await fetch(
    `${context.baseUrl}/api/v1/conversations/${second.conversationId}`,
    {
      method: "DELETE",
      headers: {
        cookie: `${context.deps.sessionCookieName}=${owner.sessionToken}`,
      },
    },
  );
  assert.equal(badCsrf.status, 403);

  const deleteAll = await fetch(`${context.baseUrl}/api/v1/me/history`, {
    method: "DELETE",
    headers: context.headers(owner),
  });
  assert.equal(deleteAll.status, 200);
  assert.deepEqual(await deleteAll.json(), { deletedCount: 1 });
  const states = await pool.query<{
    id: string;
    scope: string;
    status: string;
  }>("SELECT id, scope, status FROM conversation WHERE id = ANY($1::uuid[])", [
    [first.conversationId, second.conversationId, foreign.conversationId],
  ]);
  assert.deepEqual(
    new Map(states.rows.map((row) => [row.id, `${row.scope}:${row.status}`])),
    new Map([
      [first.conversationId, "personal:deleted"],
      [second.conversationId, "personal:deleted"],
      [foreign.conversationId, "personal:active"],
    ]),
  );
  const missingBody = await fetch(
    `${context.baseUrl}/api/v1/me/history?scope=workspace`,
    {
      method: "DELETE",
      headers: context.headers(owner),
    },
  );
  assert.equal(missingBody.status, 403);
});

test("personal history context is lexical, owner-scoped, and sent without IDs", async (t) => {
  const context = await setup(t);
  const owner = await context.addUser();
  const other = await context.addUser();
  await postChat(context, owner, {
    scope: "personal",
    message: "My private project codename is amber lighthouse",
  });
  await postChat(context, other, {
    scope: "personal",
    message: "Other person's project codename is amber lighthouse",
  });
  const next = await postChat(context, owner, {
    scope: "personal",
    message: "Remind me about my private project codename amber lighthouse",
  });
  assert.equal(next.status, 200);
  const modelPrompt = context.model.prompts.at(-1)?.prompt ?? "";
  assert.match(modelPrompt, /My private project codename is amber lighthouse/);
  assert.doesNotMatch(modelPrompt, /Other person's project codename/);
  assert.doesNotMatch(modelPrompt, new RegExp(owner.personId));
  assert.doesNotMatch(modelPrompt, new RegExp(other.personId));
});

test("idempotency conflicts, provider failures, timeouts, and rate limits leave no partial turn", async (t) => {
  const context = await setup(t, {
    chatLimit: 10,
    readLimit: 1,
    deleteLimit: 1,
    modelTimeoutMs: 50,
  });
  const user = await context.addUser();
  const key = randomUUID();
  const first = await postChat(
    context,
    user,
    { scope: "personal", message: "first" },
    key,
  );
  assert.equal(first.status, 200);
  const conflict = await postChat(
    context,
    user,
    { scope: "personal", message: "different" },
    key,
  );
  assert.equal(conflict.status, 409);
  assert.equal(getError(await conflict.json()).code, "IDEMPOTENCY_CONFLICT");

  context.model.setResponder(async () => {
    throw new Error("provider error with private content");
  });
  const failure = await postChat(context, user, {
    scope: "personal",
    message: "provider failure",
  });
  assert.equal(failure.status, 503);
  assert.equal(getError(await failure.json()).code, "DEPENDENCY_UNAVAILABLE");

  context.model.setResponder(async () => new Promise<string>(() => undefined));
  const timeout = await postChat(context, user, {
    scope: "personal",
    message: "provider timeout",
  });
  assert.equal(timeout.status, 504);
  assert.equal(getError(await timeout.json()).code, "DEADLINE_EXCEEDED");
  const incomplete = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message m JOIN conversation c ON c.id = m.conversation_id
     WHERE c.owner_person_id = $1 AND (m.content IN ('provider failure', 'provider timeout') OR m.content LIKE 'answer-%')`,
    [user.personId],
  );
  assert.equal(incomplete.rows[0]?.count, "1");

  const limitedReadOne = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal`,
    { headers: context.headers(user) },
  );
  assert.equal(limitedReadOne.status, 200);
  const limitedReadTwo = await fetch(
    `${context.baseUrl}/api/v1/conversations?scope=personal`,
    { headers: context.headers(user) },
  );
  assert.equal(limitedReadTwo.status, 429);
  assert.equal(getError(await limitedReadTwo.json()).code, "RATE_LIMITED");
  const event = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM rate_limit_event WHERE person_id = $1 AND rule = 'personal.history.read'",
    [user.personId],
  );
  assert.equal(event.rows[0]?.count, "1");
});

test("chat fails safely when PostgreSQL is unavailable", async (t) => {
  const unavailablePool = new Pool({
    connectionString: databaseUrl.replace(/:\d+\//, ":1/"),
    connectionTimeoutMillis: 100,
  });
  t.after(async () => unavailablePool.end());
  const deps: PersonalChatDependencies = {
    pool: unavailablePool,
    model: new TestModel(),
    sessionCookieName: "momos_session",
    cursorSigningSecret: randomBytes(32).toString("base64url"),
    rateLimitSecret: randomBytes(32).toString("base64url"),
    sessionCookieSecure: false,
    modelTimeoutMs: 100,
    chatLimit: 30,
    chatWindowSeconds: 60,
    readLimit: 120,
    readWindowSeconds: 60,
    deleteLimit: 10,
    deleteWindowSeconds: 3_600,
  };
  const server = createTestServer(deps);
  t.after(async () => closeServer(server));
  const url = await listen(server);
  const response = await fetch(`${url}/api/v1/conversations?scope=personal`, {
    headers: { cookie: "momos_session=unavailable" },
  });
  assert.equal(response.status, 503);
  assert.equal(getError(await response.json()).code, "DEPENDENCY_UNAVAILABLE");
});

test("personal chat rate limits writes and records a content-free event", async (t) => {
  const context = await setup(t, { chatLimit: 1 });
  const user = await context.addUser();
  const first = await postChat(context, user, {
    scope: "personal",
    message: "first allowed turn",
  });
  assert.equal(first.status, 200);
  const second = await postChat(context, user, {
    scope: "personal",
    message: "blocked second turn",
  });
  assert.equal(second.status, 429);
  assert.equal(getError(await second.json()).code, "RATE_LIMITED");
  const effects = await pool.query<{ messages: string; events: string }>(
    `SELECT (SELECT count(*)::text FROM message m JOIN conversation c ON c.id=m.conversation_id WHERE c.owner_person_id=$1) AS messages,
      (SELECT count(*)::text FROM rate_limit_event WHERE person_id=$1 AND rule='personal.chat') AS events`,
    [user.personId],
  );
  assert.equal(effects.rows[0]?.messages, "2");
  assert.equal(effects.rows[0]?.events, "1");
});

function createTestServer(deps: PersonalChatDependencies): Server {
  return createServer((request, response) => {
    const requestId = randomUUID();
    void handlePersonalChatRoute(
      request,
      response,
      new URL(request.url ?? "/", appBaseUrl),
      requestId,
      deps,
    )
      .then((handled) => {
        if (!handled && !response.headersSent) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "NOT_FOUND",
                message: "Route not found",
                requestId,
                retryable: false,
              },
            }),
          );
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Service unavailable",
                requestId,
                retryable: true,
              },
            }),
          );
        }
      });
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
