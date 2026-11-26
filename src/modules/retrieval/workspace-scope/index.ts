import type { Pool } from "pg";
import type { ModelContextItem } from "../../../contracts/v1/index.js";
import type {
  EmbeddingProvider,
  MetricsPort,
  VectorStoreProvider,
} from "../../../shared/providers/contracts/index.js";

/** Retrieves workspace context, revalidating all candidates in PostgreSQL. */
export function createWorkspaceHistoryRetriever(options: {
  pool: Pool;
  embeddings?: EmbeddingProvider;
  vectorStore?: VectorStoreProvider;
  metrics?: MetricsPort;
  resultLimit?: number;
}) {
  return {
    async retrieve(input: {
      workspaceId: string;
      conversationId: string;
      query: string;
    }): Promise<readonly ModelContextItem[]> {
      const terms = input.query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 30) ?? [];
      const tsQuery = terms.join(" | ");
      const lexical = await options.pool.query<{ id: string; score: number }>(
        `SELECT m.id, CASE WHEN c.id=$2 THEN 2.0 ELSE ts_rank(m.search_vector, to_tsquery('english',$3)) END AS score
         FROM message m JOIN conversation c ON c.id=m.conversation_id
         WHERE c.workspace_id=$1 AND c.scope='workspace' AND c.status='active'
           AND m.status='active' AND m.content IS NOT NULL
           AND (c.id=$2 OR ($3 <> '' AND m.search_vector @@ to_tsquery('english',$3)))
         ORDER BY score DESC, m.created_at DESC LIMIT 24`,
        [input.workspaceId, input.conversationId, tsQuery],
      );
      const ranked = new Map(
        lexical.rows.map((row, i) => [row.id, 2 + row.score + 1 / (i + 1)]),
      );
      try {
        if (options.embeddings && options.vectorStore) {
          const [vector] = await options.embeddings.embed([input.query]);
          if (vector) {
            const candidates = await options.vectorStore.search(
              vector,
              {
                scope: "workspace",
                scopeId: input.workspaceId,
                status: "active",
              },
              24,
            );
            candidates.forEach((candidate, i) =>
              ranked.set(
                candidate.id,
                Math.max(
                  ranked.get(candidate.id) ?? 0,
                  1 + candidate.score + 1 / (i + 1),
                ),
              ),
            );
          }
        }
      } catch {
        options.metrics?.increment("semantic_retrieval_degraded_total", {
          dependency: "embedding_or_vector_store",
        });
      }
      const ids = [...ranked.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .map(([id]) => id);
      if (!ids.length) return [];
      const hydrated = await options.pool.query<{
        content: string;
        created_at: Date;
      }>(
        `SELECT m.content,m.created_at FROM message m JOIN conversation c ON c.id=m.conversation_id
         WHERE m.id=ANY($2::uuid[]) AND m.status='active' AND m.content IS NOT NULL
           AND c.workspace_id=$1 AND c.scope='workspace' AND c.status='active'`,
        [input.workspaceId, ids],
      );
      return hydrated.rows.slice(0, options.resultLimit ?? 8).map((row) => ({
        content: row.content.slice(0, 1000),
        createdAt: row.created_at.toISOString(),
      }));
    },
  };
}
