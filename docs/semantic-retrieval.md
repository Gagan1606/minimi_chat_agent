# Semantic history retrieval

M7 adds semantic recall for personal chat history. PostgreSQL remains the authority for message ownership, active status, and content. Qdrant stores message vectors with only scope, scope ID, status, and creation time as payload metadata; every returned ID is hydrated again from PostgreSQL under the authenticated owner's personal scope before it can enter model context.

## Local setup

The local `.env.example` defaults use Gemini's `gemini-embedding-001` model at 768 dimensions and Qdrant at `http://127.0.0.1:16333`. The embedding key falls back to `MODEL_API_KEY`, so a separate key is optional when the same Gemini key is approved for embedding requests. Start the vector service with:

```powershell
docker compose up -d qdrant
```

Embedding and vector dimensions must match. Supported Qdrant metrics are `cosine`, `dot`, and `euclid`; cosine is the local default. Set `EMBEDDING_INDEXER_ENABLED=false` to disable semantic indexing and retrieval while keeping PostgreSQL full-text history search available.

For production, configure the embedding provider/model/key/dimensions and a reachable `https` `VECTOR_STORE_URL` with `VECTOR_STORE_API_KEY` explicitly. The application does not assume a local vector database outside development/test. If the vector service is unavailable at startup or during a request, chat continues with PostgreSQL full-text/current-conversation context. Missing or inconsistent provider settings fail startup rather than silently selecting a different provider.

## Indexing and privacy

The chat transaction writes both messages and their `EmbeddingOutbox` upsert records together. Migration `0003_embedding_outbox_backfill.sql` queues existing active personal messages. A bounded worker claims rows with `FOR UPDATE SKIP LOCKED`, embeds them outside the database transaction, upserts vectors, and records completion. Failures store only a fixed error code and use exponential retry delays up to the configured attempt limit. Lag is emitted as content-free structured metrics.

Retrieval combines PostgreSQL full-text/current-conversation matches with vector candidates. Vector search is filtered to the requesting person's personal scope and active records, then PostgreSQL rechecks ownership, conversation status, and message status before returning anything. Model context has only `content` and `createdAt`; vector IDs, ownership metadata, roles, and scope never enter the model DTO. Tombstoned messages are excluded immediately by the PostgreSQL recheck. Durable vector deletion and retention cleanup are completed in M9.

The Gemini embedding model accepts up to 2,048 input tokens and supports flexible vector dimensions from 128 to 3,072; 768 is the recommended default used here. See [Google's model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001).
