import type { Pool, PoolClient } from "pg";
import type {
  EmbeddingProvider,
  MetricsPort,
  VectorRecord,
  VectorStoreProvider,
} from "../../shared/providers/contracts/index.js";

interface ClaimedMessage {
  outboxId: string;
  messageId: string;
  operation: "upsert" | "delete";
  content: string;
  status: "active" | "deleted";
  scope: "personal" | "workspace";
  scopeId: string;
  createdAt: Date;
}

export function createEmbeddingIndexer(options: {
  pool: Pool;
  embeddings: EmbeddingProvider;
  vectorStore: VectorStoreProvider;
  batchSize?: number;
  maxAttempts?: number;
  metrics?: MetricsPort;
}) {
  const batchSize = options.batchSize ?? 32;
  const maxAttempts = options.maxAttempts ?? 10;

  async function claim(): Promise<ClaimedMessage[]> {
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ClaimedMessage & { id: string }>(
        `WITH ready AS (
           SELECT o.id FROM embedding_outbox o
           JOIN message m ON m.id=o.message_id
           JOIN conversation c ON c.id=m.conversation_id
           WHERE ((o.state IN ('pending','failed') AND o.available_at<=now() AND o.attempts<$2)
             OR (o.state='processing' AND o.claimed_at<now()-interval '2 minutes'))
             AND c.scope IN ('personal','workspace')
           ORDER BY o.available_at,o.created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE embedding_outbox o SET state='processing',claimed_at=now(),attempts=o.attempts+1
         FROM ready r WHERE o.id=r.id RETURNING o.id,o.message_id,o.operation`,
        [batchSize, maxAttempts],
      );
      const ids = result.rows.map((row) => row.id);
      if (!ids.length) {
        await client.query("COMMIT");
        return [];
      }
      const messages = await client.query<{
        outbox_id: string;
        message_id: string;
        operation: "upsert" | "delete";
        content: string;
        message_status: "active" | "deleted";
        scope: "personal" | "workspace";
        scope_id: string;
        created_at: Date;
      }>(
        `SELECT o.id AS outbox_id,o.message_id,o.operation,m.content,m.status AS message_status,
           c.scope,COALESCE(c.workspace_id,c.owner_person_id) AS scope_id,m.created_at
         FROM embedding_outbox o JOIN message m ON m.id=o.message_id
         JOIN conversation c ON c.id=m.conversation_id
         WHERE o.id=ANY($1::uuid[]) AND c.scope IN ('personal','workspace')`,
        [ids],
      );
      await client.query("COMMIT");
      return messages.rows.map((row) => ({
        outboxId: row.outbox_id,
        messageId: row.message_id,
        operation: row.operation,
        content: row.content,
        status: row.message_status,
        scope: row.scope,
        scopeId: row.scope_id,
        createdAt: row.created_at,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function updateOutbox(
    client: PoolClient,
    rows: readonly ClaimedMessage[],
    outcome: "completed" | "failed",
    errorCode?: string,
  ): Promise<void> {
    for (const row of rows) {
      await client.query(
        `UPDATE embedding_outbox SET state=$2,claimed_at=NULL,last_error_code=$3,
           available_at=CASE WHEN $2='failed' THEN now()+LEAST(300,power(2,LEAST(attempts,8))::int)*interval '1 second' ELSE available_at END
         WHERE id=$1 AND state='processing'`,
        [row.outboxId, outcome, errorCode ?? null],
      );
    }
  }

  async function recordLag(): Promise<void> {
    if (!options.metrics) return;
    try {
      const result = await options.pool.query<{
        count: string;
        oldest_seconds: number | null;
      }>(
        `SELECT count(*)::text AS count,
         COALESCE(EXTRACT(epoch FROM now()-min(created_at)),0)::float8 AS oldest_seconds
       FROM embedding_outbox WHERE state IN ('pending','failed')`,
      );
      options.metrics.gauge(
        "embedding_indexer_lag_messages",
        Number(result.rows[0]?.count ?? 0),
      );
      options.metrics.gauge(
        "embedding_indexer_oldest_lag_seconds",
        result.rows[0]?.oldest_seconds ?? 0,
      );
    } catch {
      // Telemetry failures must not change the outbox operation result.
    }
  }

  return {
    async processBatch(): Promise<number> {
      const rows = await claim();
      if (!rows.length) {
        await recordLag();
        return 0;
      }
      const toDelete = rows.filter(
        (row) => row.operation === "delete" || row.status !== "active",
      );
      const toEmbed = rows.filter(
        (row) => row.operation === "upsert" && row.status === "active",
      );
      try {
        const vectors = toEmbed.length
          ? await options.embeddings.embed(toEmbed.map((row) => row.content))
          : [];
        if (vectors.length !== toEmbed.length)
          throw new Error("Embedding count did not match claimed messages");
        const records: VectorRecord[] = toEmbed.map((row, index) => ({
          id: row.messageId,
          vector: vectors[index]!,
          metadata: {
            scope: row.scope,
            scopeId: row.scopeId,
            status: "active",
            createdAt: row.createdAt.toISOString(),
          },
        }));
        await options.vectorStore.upsert(records);
        await options.vectorStore.delete(toDelete.map((row) => row.messageId));
        const client = await options.pool.connect();
        try {
          await client.query("BEGIN");
          await updateOutbox(client, rows, "completed");
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        options.metrics?.increment(
          "embedding_indexer_processed_total",
          {},
          rows.length,
        );
        await recordLag();
        return rows.length;
      } catch {
        const client = await options.pool.connect();
        try {
          await client.query("BEGIN");
          await updateOutbox(client, rows, "failed", "provider_unavailable");
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        options.metrics?.increment(
          "embedding_indexer_failures_total",
          {},
          rows.length,
        );
        await recordLag();
        return 0;
      }
    },
  };
}
