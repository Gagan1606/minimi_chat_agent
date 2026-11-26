INSERT INTO embedding_outbox (id, message_id, operation)
SELECT gen_random_uuid(), m.id, 'upsert'
FROM message m
JOIN conversation c ON c.id=m.conversation_id
WHERE c.scope='personal' AND c.status='active' AND m.status='active'
ON CONFLICT (message_id, operation) DO NOTHING;
