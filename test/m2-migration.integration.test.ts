import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import test, { after, before } from "node:test";
import { runMigrations } from "../src/db/migrate.js";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a real local PostgreSQL database before testing.",
  );
}

const schemaName = `m2_upgrade_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl });
let upgradePool: Pool;

before(async () => {
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  upgradePool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName}`,
  });
});

after(async () => {
  await upgradePool?.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool.end();
});

test("M2 migration upgrades an M1 schema without losing identity/session data", async () => {
  const migrationDirectory = resolve(process.cwd(), "src/db/migrations");
  const m1Sql = await readFile(
    resolve(migrationDirectory, "0001_identity_session.sql"),
    "utf8",
  );
  await upgradePool.query(`
    CREATE TABLE momos_migration (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await upgradePool.query(m1Sql);
  await upgradePool.query(
    "INSERT INTO momos_migration (name, checksum) VALUES ($1, $2)",
    [
      "0001_identity_session.sql",
      createHash("sha256").update(m1Sql).digest("hex"),
    ],
  );

  const personId = randomUUID();
  const sessionTokenHash = createHash("sha256")
    .update(randomUUID())
    .digest("hex");
  await upgradePool.query(
    "INSERT INTO person (id, email, display_name) VALUES ($1, $2, $3)",
    [personId, `${personId}@example.test`, "Migration fixture"],
  );
  await upgradePool.query(
    "INSERT INTO auth_identity (id, person_id, issuer, subject) VALUES ($1, $2, $3, $4)",
    [randomUUID(), personId, "https://issuer.example", personId],
  );
  await upgradePool.query(
    `INSERT INTO session (token_hash, person_id, csrf_token_hash, platform_admin, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, true, now() + interval '1 hour', now() + interval '1 day')`,
    [sessionTokenHash, personId, "a".repeat(64)],
  );

  await runMigrations(upgradePool, migrationDirectory);
  await runMigrations(upgradePool, migrationDirectory);

  const preserved = await upgradePool.query<{
    person_count: string;
    identity_count: string;
    session_count: string;
    migration_count: string;
  }>(
    `
    SELECT
      (SELECT count(*) FROM person WHERE id = $1)::text AS person_count,
      (SELECT count(*) FROM auth_identity WHERE person_id = $1)::text AS identity_count,
      (SELECT count(*) FROM session WHERE person_id = $1)::text AS session_count,
      (SELECT count(*) FROM momos_migration)::text AS migration_count
  `,
    [personId],
  );
  assert.deepEqual(preserved.rows[0], {
    person_count: "1",
    identity_count: "1",
    session_count: "1",
    migration_count: "3",
  });

  const tables = await upgradePool.query<{ table_name: string }>(
    `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = $1 ORDER BY table_name
  `,
    [schemaName],
  );
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  for (const table of [
    "company",
    "company_membership",
    "workspace",
    "workspace_membership",
    "conversation",
    "message",
    "citation",
    "idempotency_record",
    "admin_audit_event",
    "rate_limit_event",
    "embedding_outbox",
    "platform_admin_assignment",
  ]) {
    assert.equal(tableNames.has(table), true, `expected ${table} table`);
  }
  const indexes = await upgradePool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1",
    [schemaName],
  );
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  for (const index of [
    "company_membership_one_admin_idx",
    "workspace_membership_one_admin_idx",
    "conversation_personal_listing_idx",
    "conversation_workspace_listing_idx",
    "message_fulltext_idx",
    "idempotency_expiration_idx",
    "rate_limit_platform_time_idx",
    "embedding_outbox_ready_idx",
  ]) {
    assert.equal(indexNames.has(index), true, `expected ${index} index`);
  }
  const preservedAdmin = await upgradePool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM platform_admin_assignment WHERE person_id = $1",
    [personId],
  );
  assert.equal(preservedAdmin.rows[0]?.count, "1");
});

test("M2 schema enforces membership uniqueness and prevents cross-company workspace membership", async () => {
  const personA = randomUUID();
  const personB = randomUUID();
  const personC = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  for (const id of [personA, personB, personC]) {
    await upgradePool.query("INSERT INTO person (id) VALUES ($1)", [id]);
  }
  for (const id of [companyA, companyB]) {
    await upgradePool.query("INSERT INTO company (id, name) VALUES ($1, $2)", [
      id,
      id,
    ]);
  }
  await upgradePool.query(
    "INSERT INTO company_membership (person_id, company_id, role) VALUES ($1, $2, 'company_admin'), ($3, $4, 'company_admin')",
    [personA, companyA, personB, companyB],
  );
  await upgradePool.query(
    "INSERT INTO company_membership (person_id, company_id, role) VALUES ($1, $2, 'member')",
    [personC, companyA],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO company_membership (person_id, company_id, role) VALUES ($1, $2, 'member')",
      [personA, companyB],
    ),
  );
  await assert.rejects(
    upgradePool.query(
      "UPDATE company_membership SET role = 'company_admin' WHERE person_id = $1",
      [personC],
    ),
  );
  await upgradePool.query(
    "INSERT INTO workspace (id, company_id, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')",
    [workspaceA, companyA, workspaceB, companyB],
  );
  const workspaceA2 = randomUUID();
  await upgradePool.query(
    "INSERT INTO workspace (id, company_id, name) VALUES ($1, $2, 'A2')",
    [workspaceA2, companyA],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'member')",
      [personA, companyA, workspaceB],
    ),
  );
  await upgradePool.query(
    "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'workspace_admin')",
    [personA, companyA, workspaceA],
  );
  await upgradePool.query(
    "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'workspace_admin')",
    [personB, companyB, workspaceB],
  );
  await upgradePool.query(
    "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'member')",
    [personC, companyA, workspaceA],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'member')",
      [personC, companyA, workspaceA2],
    ),
  );
  await assert.rejects(
    upgradePool.query(
      "UPDATE workspace_membership SET role = 'workspace_admin' WHERE person_id = $1",
      [personC],
    ),
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'member')",
      [personB, companyB, workspaceA],
    ),
  );
});

test("M2 conversation, message, idempotency and outbox constraints hold", async () => {
  const personId = randomUUID();
  const companyId = randomUUID();
  const workspaceId = randomUUID();
  const workspaceConversationId = randomUUID();
  const personalConversationId = randomUUID();
  const messageId = randomUUID();
  await upgradePool.query("INSERT INTO person (id) VALUES ($1)", [personId]);
  await upgradePool.query(
    "INSERT INTO company (id, name) VALUES ($1, 'Test')",
    [companyId],
  );
  await upgradePool.query(
    "INSERT INTO company_membership (person_id, company_id, role) VALUES ($1, $2, 'member')",
    [personId, companyId],
  );
  await upgradePool.query(
    "INSERT INTO workspace (id, company_id, name) VALUES ($1, $2, 'Test workspace')",
    [workspaceId, companyId],
  );
  await upgradePool.query(
    "INSERT INTO workspace_membership (person_id, company_id, workspace_id, role) VALUES ($1, $2, $3, 'member')",
    [personId, companyId, workspaceId],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO conversation (id, scope, owner_person_id, workspace_id) VALUES ($1, 'personal', $2, $3)",
      [randomUUID(), personId, workspaceId],
    ),
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO conversation (id, scope, owner_person_id) VALUES ($1, 'workspace', $2)",
      [randomUUID(), personId],
    ),
  );
  await upgradePool.query(
    "INSERT INTO conversation (id, scope, owner_person_id, workspace_id) VALUES ($1, 'workspace', $2, $3), ($4, 'personal', $2, NULL)",
    [workspaceConversationId, personId, workspaceId, personalConversationId],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO message (id, conversation_id, role, content) VALUES ($1, $2, 'system', 'private')",
      [randomUUID(), personalConversationId],
    ),
  );
  await upgradePool.query(
    "INSERT INTO message (id, conversation_id, role, content) VALUES ($1, $2, 'user', 'meaning based retrieval')",
    [messageId, workspaceConversationId],
  );
  await upgradePool.query(
    `INSERT INTO idempotency_record (principal_id, scope, idempotency_key, request_hash, state, expires_at)
     VALUES ($1, 'workspace', 'key-one', $2, 'in_progress', now() + interval '1 day')`,
    [personId, "a".repeat(64)],
  );
  await assert.rejects(
    upgradePool.query(
      `INSERT INTO idempotency_record (principal_id, scope, idempotency_key, request_hash, state, expires_at)
       VALUES ($1, 'workspace', 'key-one', $2, 'in_progress', now() + interval '1 day')`,
      [personId, "b".repeat(64)],
    ),
  );
  await upgradePool.query(
    "INSERT INTO embedding_outbox (id, message_id, operation) VALUES ($1, $2, 'upsert')",
    [randomUUID(), messageId],
  );
  await assert.rejects(
    upgradePool.query(
      "INSERT INTO embedding_outbox (id, message_id, operation) VALUES ($1, $2, 'upsert')",
      [randomUUID(), messageId],
    ),
  );
});
