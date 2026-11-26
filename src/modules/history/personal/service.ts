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
      `UPDATE message SET status='deleted', deleted_at=now(), content='[deleted]'
       WHERE conversation_id=$1 AND status='active'`,
      [conversationId],
    );
    await removeCitationsAndQueueVectors(client, conversationId);
    return true;
  });
}

export async function deleteAllPersonalHistory(
  pool: Pool,
  personId: string,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE message SET status='deleted', deleted_at=now(), content='[deleted]'
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
    await client.query(
      `DELETE FROM citation WHERE assistant_message_id IN (
         SELECT m.id FROM message m JOIN conversation c ON c.id=m.conversation_id
         WHERE c.owner_person_id=$1 AND c.scope='personal' AND c.status='deleted'
       )`,
      [personId],
    );
    await client.query(
      `INSERT INTO embedding_outbox(id,message_id,operation)
       SELECT gen_random_uuid(),m.id,'delete' FROM message m JOIN conversation c ON c.id=m.conversation_id
       WHERE c.owner_person_id=$1 AND c.scope='personal' AND c.status='deleted'
       ON CONFLICT(message_id,operation) DO UPDATE SET state='pending',available_at=now(),claimed_at=NULL,attempts=0,last_error_code=NULL`,
      [personId],
    );
    return result.rowCount ?? 0;
  });
}

export async function deleteWorkspaceConversation(
  pool: Pool,
  personId: string,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const changed = await client.query(
      `UPDATE conversation SET status='deleted',deleted_at=now(),updated_at=now()
       WHERE id=$1 AND owner_person_id=$2 AND workspace_id=$3 AND scope='workspace' AND status='active' RETURNING id`,
      [conversationId, personId, workspaceId],
    );
    const exists = changed.rowCount
      ? true
      : Boolean(
          (
            await client.query(
              `SELECT 1 FROM conversation WHERE id=$1 AND owner_person_id=$2 AND workspace_id=$3 AND scope='workspace' AND status='deleted'`,
              [conversationId, personId, workspaceId],
            )
          ).rowCount,
        );
    if (!exists) return false;
    await client.query(
      "UPDATE message SET status='deleted',deleted_at=now(),content='[deleted]' WHERE conversation_id=$1 AND status='active'",
      [conversationId],
    );
    await removeCitationsAndQueueVectors(client, conversationId);
    return true;
  });
}

export async function deleteAllWorkspaceHistory(
  pool: Pool,
  personId: string,
  workspaceId: string,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE message SET status='deleted',deleted_at=now(),content='[deleted]' WHERE status='active' AND conversation_id IN (SELECT id FROM conversation WHERE owner_person_id=$1 AND workspace_id=$2 AND scope='workspace' AND status='active')`,
      [personId, workspaceId],
    );
    const result = await client.query(
      `UPDATE conversation SET status='deleted',deleted_at=now(),updated_at=now() WHERE owner_person_id=$1 AND workspace_id=$2 AND scope='workspace' AND status='active' RETURNING id`,
      [personId, workspaceId],
    );
    await client.query(
      `DELETE FROM citation WHERE assistant_message_id IN (SELECT m.id FROM message m JOIN conversation c ON c.id=m.conversation_id WHERE c.owner_person_id=$1 AND c.workspace_id=$2 AND c.scope='workspace' AND c.status='deleted')`,
      [personId, workspaceId],
    );
    await client.query(
      `INSERT INTO embedding_outbox(id,message_id,operation) SELECT gen_random_uuid(),m.id,'delete' FROM message m JOIN conversation c ON c.id=m.conversation_id WHERE c.owner_person_id=$1 AND c.workspace_id=$2 AND c.scope='workspace' AND c.status='deleted' ON CONFLICT(message_id,operation) DO UPDATE SET state='pending',available_at=now(),claimed_at=NULL,attempts=0,last_error_code=NULL`,
      [personId, workspaceId],
    );
    return result.rowCount ?? 0;
  });
}

async function removeCitationsAndQueueVectors(
  client: import("pg").PoolClient,
  conversationId: string,
): Promise<void> {
  await client.query(
    "DELETE FROM citation WHERE assistant_message_id IN (SELECT id FROM message WHERE conversation_id=$1)",
    [conversationId],
  );
  await client.query(
    `INSERT INTO embedding_outbox(id,message_id,operation) SELECT gen_random_uuid(),id,'delete' FROM message WHERE conversation_id=$1 ON CONFLICT(message_id,operation) DO UPDATE SET state='pending',available_at=now(),claimed_at=NULL,attempts=0,last_error_code=NULL`,
    [conversationId],
  );
}
