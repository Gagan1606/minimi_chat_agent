import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type Pool as PoolType } from "pg";
import { createQdrantVectorStore } from "../src/providers/vector-store/qdrant.js";
import { createHybridHistoryRetriever } from "../src/modules/retrieval/history.js";
import { createEmbeddingIndexer } from "../src/workers/embedding-indexer/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createGeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";

const vectorStoreUrl =
  process.env.VECTOR_STORE_URL?.trim() || "http://127.0.0.1:16333";
const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://momos:momos@127.0.0.1:15432/momos";
const bootstrapPool = new Pool({ connectionString: databaseUrl });
const schema = `m7_${randomUUID().replaceAll("-", "")}`;
let pool: PoolType;

test.before(async () => {
  await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool);
});
test.after(async () => {
  await pool?.end();
  await bootstrapPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await bootstrapPool.end();
});

test("Gemini embeddings use distinct retrieval tasks and enforce dimensions", async () => {
  const taskTypes: string[] = [];
  const provider = createGeminiEmbeddingProvider({
    apiKey: "test-key",
    model: "test-embedding-model",
    dimensions: 3,
    client: {
      models: {
        async embedContent(input) {
          taskTypes.push(input.config.taskType);
          return {
            embeddings: input.contents.map(() => ({ values: [1, 0, 0] })),
          };
        },
      },
    },
  });
  assert.deepEqual(await provider.embed(["message"]), [[1, 0, 0]]);
  assert.deepEqual(await provider.embedQuery(["question"]), [[1, 0, 0]]);
  assert.deepEqual(taskTypes, ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]);
  await assert.rejects(provider.embed([" "]), /must not be empty/);
});

test("Qdrant adapter creates isolated, filtered vectors and deletes them", async () => {
  const collection = `momos-test-${randomUUID()}`;
  const store = createQdrantVectorStore({
    baseUrl: vectorStoreUrl,
    collection,
    dimensions: 3,
    timeoutMs: 2_000,
  });
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const ownMessageId = randomUUID();
  const otherMessageId = randomUUID();

  try {
    await store.initialize();
    await store.upsert([
      {
        id: ownMessageId,
        vector: [1, 0, 0],
        metadata: {
          scope: "personal",
          scopeId: ownerId,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      },
      {
        id: otherMessageId,
        vector: [0.99, 0.01, 0],
        metadata: {
          scope: "personal",
          scopeId: otherOwnerId,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      },
    ]);

    const candidates = await store.search(
      [1, 0, 0],
      { scope: "personal", scopeId: ownerId, status: "active" },
      10,
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      [ownMessageId],
    );

    await store.delete([ownMessageId]);
    const afterDelete = await store.search(
      [1, 0, 0],
      { scope: "personal", scopeId: ownerId, status: "active" },
      10,
    );
    assert.deepEqual(afterDelete, []);
  } finally {
    await store.dropCollection();
  }
});

test("hybrid retrieval revalidates vector IDs against the owner in PostgreSQL", async () => {
  const collection = `momos-test-${randomUUID()}`;
  const store = createQdrantVectorStore({
    baseUrl: vectorStoreUrl,
    collection,
    dimensions: 3,
    timeoutMs: 2_000,
  });
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const semanticMessageId = randomUUID();
  const otherMessageId = randomUUID();
  const deletedMessageId = randomUUID();
  try {
    await store.initialize();
    await pool.query("INSERT INTO person(id) VALUES ($1),($2)", [
      ownerId,
      otherOwnerId,
    ]);
    await pool.query(
      "INSERT INTO conversation(id,scope,owner_person_id,title) VALUES ($1,'personal',$2,'owner'),($3,'personal',$4,'other')",
      [conversationId, ownerId, otherConversationId, otherOwnerId],
    );
    await pool.query(
      `INSERT INTO message(id,conversation_id,role,content) VALUES
       ($1,$2,'user',$3),($4,$5,'user',$6),($7,$2,'user','A deleted historical memory')`,
      [
        semanticMessageId,
        conversationId,
        "We agreed to book a cabin near the lake for the holiday.",
        otherMessageId,
        otherConversationId,
        "Secret from another account.",
        deletedMessageId,
      ],
    );
    await pool.query(
      "UPDATE message SET status='deleted',deleted_at=now() WHERE id=$1",
      [deletedMessageId],
    );
    await store.upsert([
      {
        id: semanticMessageId,
        vector: [1, 0, 0],
        metadata: {
          scope: "personal",
          scopeId: ownerId,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      },
      {
        id: otherMessageId,
        vector: [0.99, 0.01, 0],
        metadata: {
          scope: "personal",
          scopeId: ownerId,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      },
      {
        id: deletedMessageId,
        vector: [0.98, 0.02, 0],
        metadata: {
          scope: "personal",
          scopeId: ownerId,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      },
    ]);
    const retriever = createHybridHistoryRetriever({
      pool,
      embeddings: {
        async embed() {
          return [[1, 0, 0]];
        },
      },
      vectorStore: store,
    });
    const context = await retriever.retrieve({
      personId: ownerId,
      conversationId: randomUUID(),
      query: "Where should we stay on vacation?",
    });
    assert.deepEqual(
      context.map((item) => item.content),
      ["We agreed to book a cabin near the lake for the holiday."],
    );
    assert.deepEqual(Object.keys(context[0]!).sort(), ["content", "createdAt"]);
    const lexicalFallback = createHybridHistoryRetriever({
      pool,
      embeddings: {
        async embed() {
          throw new Error("provider offline");
        },
      },
      vectorStore: {
        async upsert() {},
        async delete() {},
        async search() {
          throw new Error("vector service offline");
        },
      },
    });
    const fallbackContext = await lexicalFallback.retrieve({
      personId: ownerId,
      conversationId: randomUUID(),
      query: "cabin lake holiday",
    });
    assert.equal(
      fallbackContext[0]?.content,
      "We agreed to book a cabin near the lake for the holiday.",
    );
  } finally {
    await store.dropCollection();
    await pool.query("DELETE FROM message WHERE id=ANY($1::uuid[])", [
      [semanticMessageId, otherMessageId, deletedMessageId],
    ]);
    await pool.query("DELETE FROM conversation WHERE id=ANY($1::uuid[])", [
      [conversationId, otherConversationId],
    ]);
    await pool.query("DELETE FROM person WHERE id=ANY($1::uuid[])", [
      [ownerId, otherOwnerId],
    ]);
  }
});

test("outbox worker indexes a message once using a real Qdrant collection", async () => {
  const collection = `momos-test-${randomUUID()}`;
  const store = createQdrantVectorStore({
    baseUrl: vectorStoreUrl,
    collection,
    dimensions: 3,
    timeoutMs: 2_000,
  });
  const personId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const outboxId = randomUUID();
  try {
    await store.initialize();
    await pool.query("INSERT INTO person(id) VALUES ($1)", [personId]);
    await pool.query(
      "INSERT INTO conversation(id,scope,owner_person_id,title) VALUES ($1,'personal',$2,'worker')",
      [conversationId, personId],
    );
    await pool.query(
      "INSERT INTO message(id,conversation_id,role,content) VALUES ($1,$2,'user','outbox test')",
      [messageId, conversationId],
    );
    await pool.query(
      "INSERT INTO embedding_outbox(id,message_id,operation) VALUES ($1,$2,'upsert')",
      [outboxId, messageId],
    );
    const worker = createEmbeddingIndexer({
      pool,
      embeddings: {
        async embed(texts) {
          return texts.map(() => [0, 1, 0]);
        },
      },
      vectorStore: store,
    });
    assert.equal(await worker.processBatch(), 1);
    assert.equal(await worker.processBatch(), 0);
    const state = await pool.query<{ state: string }>(
      "SELECT state FROM embedding_outbox WHERE id=$1",
      [outboxId],
    );
    assert.equal(state.rows[0]?.state, "completed");
    const indexed = await store.search(
      [0, 1, 0],
      { scope: "personal", scopeId: personId, status: "active" },
      10,
    );
    assert.deepEqual(
      indexed.map((candidate) => candidate.id),
      [messageId],
    );
  } finally {
    await store.dropCollection();
    await pool.query("DELETE FROM embedding_outbox WHERE message_id=$1", [
      messageId,
    ]);
    await pool.query("DELETE FROM message WHERE id=$1", [messageId]);
    await pool.query("DELETE FROM conversation WHERE id=$1", [conversationId]);
    await pool.query("DELETE FROM person WHERE id=$1", [personId]);
  }
});

test("outbox worker records retryable provider failures without message content", async () => {
  const collection = `momos-test-${randomUUID()}`;
  const store = createQdrantVectorStore({
    baseUrl: vectorStoreUrl,
    collection,
    dimensions: 3,
    timeoutMs: 2_000,
  });
  const personId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const outboxId = randomUUID();
  try {
    await store.initialize();
    await pool.query("INSERT INTO person(id) VALUES ($1)", [personId]);
    await pool.query(
      "INSERT INTO conversation(id,scope,owner_person_id,title) VALUES ($1,'personal',$2,'retry')",
      [conversationId, personId],
    );
    await pool.query(
      "INSERT INTO message(id,conversation_id,role,content) VALUES ($1,$2,'user','private retry content')",
      [messageId, conversationId],
    );
    await pool.query(
      "INSERT INTO embedding_outbox(id,message_id,operation) VALUES ($1,$2,'upsert')",
      [outboxId, messageId],
    );
    const brokenWorker = createEmbeddingIndexer({
      pool,
      embeddings: {
        async embed() {
          throw new Error("sensitive upstream error");
        },
      },
      vectorStore: store,
    });
    assert.equal(await brokenWorker.processBatch(), 0);
    const failed = await pool.query<{
      state: string;
      attempts: number;
      last_error_code: string;
    }>(
      "SELECT state,attempts,last_error_code FROM embedding_outbox WHERE id=$1",
      [outboxId],
    );
    assert.deepEqual(failed.rows[0], {
      state: "failed",
      attempts: 1,
      last_error_code: "provider_unavailable",
    });
    await pool.query(
      "UPDATE embedding_outbox SET available_at=now() WHERE id=$1",
      [outboxId],
    );
    const retryWorker = createEmbeddingIndexer({
      pool,
      embeddings: {
        async embed(texts) {
          return texts.map(() => [0, 0, 1]);
        },
      },
      vectorStore: store,
    });
    assert.equal(await retryWorker.processBatch(), 1);
    const retried = await pool.query<{ state: string }>(
      "SELECT state FROM embedding_outbox WHERE id=$1",
      [outboxId],
    );
    assert.equal(retried.rows[0]?.state, "completed");
  } finally {
    await store.dropCollection();
    await pool.query("DELETE FROM embedding_outbox WHERE message_id=$1", [
      messageId,
    ]);
    await pool.query("DELETE FROM message WHERE id=$1", [messageId]);
    await pool.query("DELETE FROM conversation WHERE id=$1", [conversationId]);
    await pool.query("DELETE FROM person WHERE id=$1", [personId]);
  }
});
