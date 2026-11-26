import { withTransaction } from "../../../db/transactions.js";
import type { Pool } from "pg";

export async function deletePersonalConversation(
  pool: Pool,
  personId: string,
  conversationId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE conversation SET status='deleted', deleted_at=now(), updated_at=now()
       WHERE id=$1 AND owner_person_id=$2 AND scope='personal' AND status='active' RETURNING id`,
      [conversationId, personId],
    );
    if (!updated.rowCount) {
      const alreadyDeleted = await client.query(
        `SELECT 1 FROM conversation WHERE id=$1 AND owner_person_id=$2 AND scope='personal' AND status='deleted'`,
        [conversationId, personId],
      );
      if (!alreadyDeleted.rowCount) return false;
    }
    await client.query(
      `UPDATE message SET status='deleted', deleted_at=now()
       WHERE conversation_id=$1 AND status='active'`,
      [conversationId],
    );
    return true;
  });
}

export async function deleteAllPersonalHistory(
  pool: Pool,
  personId: string,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE message SET status='deleted', deleted_at=now()
       WHERE status='active' AND conversation_id IN (
         SELECT id FROM conversation WHERE owner_person_id=$1 AND scope='personal' AND status='active'
       )`,
      [personId],
    );
    const result = await client.query<{ id: string }>(
      `UPDATE conversation SET status='deleted', deleted_at=now(), updated_at=now()
       WHERE owner_person_id=$1 AND scope='personal' AND status='active' RETURNING id`,
      [personId],
    );
    return result.rowCount ?? 0;
  });
}
