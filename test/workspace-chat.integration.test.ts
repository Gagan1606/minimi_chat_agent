import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { createWorkspaceHistoryRetriever } from "../src/modules/retrieval/workspace-scope/index.js";
import { handleWorkspaceChatRoute } from "../src/modules/chat/workspace/routes.js";
import { runDeletionCleanup } from "../src/workers/deletion-cleanup/index.js";

const url =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://momos:momos@127.0.0.1:15432/momos";
const schema = `m8_${randomUUID().replaceAll("-", "")}`;
const root = new Pool({ connectionString: url });
test("workspace retrieval returns same-workspace content only with identity-free DTOs", async (t) => {
  await root.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  t.after(async () => {
    await pool.end();
    await root.query(`DROP SCHEMA "${schema}" CASCADE`);
    await root.end();
  });
  await runMigrations(pool);
  const company = randomUUID(),
    workspace = randomUUID(),
    otherWorkspace = randomUUID(),
    person = randomUUID(),
    otherPerson = randomUUID();
  await pool.query("INSERT INTO person(id) VALUES($1),($2)", [
    person,
    otherPerson,
  ]);
  await pool.query("INSERT INTO company(id,name) VALUES($1,'Acme')", [company]);
  await pool.query(
    "INSERT INTO company_membership(person_id,company_id,role) VALUES($1,$2,'member'),($3,$2,'member')",
    [person, company, otherPerson],
  );
  await pool.query(
    "INSERT INTO workspace(id,company_id,name) VALUES($1,$3,'A'),($2,$3,'B')",
    [workspace, otherWorkspace, company],
  );
  await pool.query(
    "INSERT INTO workspace_membership(person_id,company_id,workspace_id) VALUES($1,$3,$4),($2,$3,$5)",
    [person, otherPerson, company, workspace, otherWorkspace],
  );
  const a = randomUUID(),
    b = randomUUID(),
    personal = randomUUID();
  await pool.query(
    "INSERT INTO conversation(id,scope,owner_person_id,workspace_id) VALUES($1,'workspace',$2,$3),($4,'workspace',$5,$6),($7,'personal',$2,NULL)",
    [a, person, workspace, b, otherPerson, otherWorkspace, personal],
  );
  await pool.query(
    "INSERT INTO message(id,conversation_id,role,content) VALUES($1,$4,'user','Project Orion delivery is Friday'),($2,$5,'user','Project Orion is delayed'),($3,$6,'user','Project Orion personal secret')",
    [randomUUID(), randomUUID(), randomUUID(), a, b, personal],
  );
  const retriever = createWorkspaceHistoryRetriever({ pool });
  const context = await retriever.retrieve({
    workspaceId: workspace,
    conversationId: randomUUID(),
    query: "Orion delivery",
  });
  assert.equal(context.length, 1);
  assert.match(context[0]!.content, /Friday/);
  assert.deepEqual(Object.keys(context[0]!).sort(), ["content", "createdAt"]);
  const userToken = randomUUID(),
    csrf = randomUUID(),
    outsiderToken = randomUUID(),
    outsider = randomUUID(),
    outsiderCsrf = randomUUID();
  await pool.query("INSERT INTO person(id) VALUES($1)", [outsider]);
  for (const [personId, token, csrfValue] of [
    [person, userToken, csrf],
    [outsider, outsiderToken, outsiderCsrf],
  ] as const)
    await pool.query(
      "INSERT INTO session(token_hash,person_id,csrf_token_hash,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,now()+interval '1 hour',now()+interval '1 day')",
      [
        createHash("sha256").update(token).digest("hex"),
        personId,
        createHash("sha256").update(csrfValue).digest("hex"),
      ],
    );
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleWorkspaceChatRoute(req, res, url, randomUUID(), {
      pool,
      model: {
        async generate(prompt) {
          prompts.push(prompt);
          return "safe team answer";
        },
      },
      retriever,
      sessionCookieName: "momos_session",
      modelTimeoutMs: 10000,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/workspaces/${workspace}/chat`;
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "workspace", message: "hello" }),
  });
  assert.equal(denied.status, 401);
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: {
      cookie: `momos_session=${userToken}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "personal", message: "hello" }),
  });
  assert.equal(invalid.status, 400);
  const success = await fetch(endpoint, {
    method: "POST",
    headers: {
      cookie: `momos_session=${userToken}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "workspace", message: "Orion delivery" }),
  });
  assert.equal(success.status, 200);
  const successBody = (await success.json()) as {
    answer: string;
    conversationId: string;
  };
  assert.equal(successBody.answer, "safe team answer");
  assert.match(prompts[0]!, /Friday/);
  assert.doesNotMatch(prompts[0]!, new RegExp(person));
  const remove = await fetch(
    `${endpoint.replace(/\/chat$/, `/conversations/${successBody.conversationId}`)}`,
    {
      method: "DELETE",
      headers: { cookie: `momos_session=${userToken}`, "x-csrf-token": csrf },
    },
  );
  assert.equal(remove.status, 200);
  const scrubbed = await pool.query<{
    id: string;
    status: string;
    content: string;
  }>("SELECT id,status,content FROM message WHERE conversation_id=$1", [
    successBody.conversationId,
  ]);
  assert.equal(scrubbed.rowCount, 2);
  assert.ok(
    scrubbed.rows.every(
      (row) => row.status === "deleted" && row.content === "[deleted]",
    ),
  );
  assert.equal(
    await pool
      .query(
        "SELECT id FROM embedding_outbox WHERE message_id=ANY($1::uuid[]) AND operation='delete'",
        [scrubbed.rows.map((row) => row.id)],
      )
      .then((x) => x.rowCount),
    2,
  );
  const deletedContext = await createWorkspaceHistoryRetriever({
    pool,
    embeddings: {
      async embed() {
        return [[1, 0, 0]];
      },
    },
    vectorStore: {
      async upsert() {},
      async delete() {},
      async search() {
        return scrubbed.rows.map((row) => ({ id: row.id, score: 1 }));
      },
    },
  }).retrieve({
    workspaceId: workspace,
    conversationId: randomUUID(),
    query: "Orion",
  });
  assert.ok(deletedContext.every((item) => item.content !== "[deleted]"));
  await pool.query(
    "INSERT INTO idempotency_record(principal_id,scope,idempotency_key,request_hash,state,response_status,expires_at) VALUES($1,'workspace','expired-cleanup',$2,'completed',200,now()-interval '1 minute')",
    [person, "0".repeat(64)],
  );
  assert.equal((await runDeletionCleanup(pool)).expiredIdempotencyRecords, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM idempotency_record WHERE idempotency_key='expired-cleanup'",
      )
    ).rowCount,
    0,
  );
  const cross = await fetch(endpoint, {
    method: "POST",
    headers: {
      cookie: `momos_session=${outsiderToken}`,
      "x-csrf-token": outsiderCsrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "workspace", message: "hello" }),
  });
  assert.equal(cross.status, 404);
  assert.equal(
    await pool
      .query(
        "SELECT id FROM conversation WHERE owner_person_id=$1 AND workspace_id=$2",
        [person, workspace],
      )
      .then((x) => x.rowCount),
    2,
  );
  assert.equal(
    await pool
      .query(
        "SELECT m.id FROM message m JOIN conversation c ON c.id=m.conversation_id WHERE c.owner_person_id=$1 AND c.workspace_id=$2",
        [person, workspace],
      )
      .then((x) => x.rowCount),
    3,
  );
});
