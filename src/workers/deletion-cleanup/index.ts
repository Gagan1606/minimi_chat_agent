import type { Pool } from "pg";
import { withTransaction } from "../../db/transactions.js";

export interface CleanupResult {
  expiredIdempotencyRecords: number;
  completedOutboxRecords: number;
}

/** Purges expired metadata only after vector deletions have completed. */
export async function runDeletionCleanup(pool: Pool): Promise<CleanupResult> {
  return withTransaction(pool, async (client) => {
    const idempotency = await client.query(
      "DELETE FROM idempotency_record WHERE expires_at <= now()",
    );
    const outbox = await client.query(
      `DELETE FROM embedding_outbox WHERE state='completed'
       AND created_at < now() - interval '30 days'`,
    );
    return {
      expiredIdempotencyRecords: idempotency.rowCount ?? 0,
      completedOutboxRecords: outbox.rowCount ?? 0,
    };
  });
}
