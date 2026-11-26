import type { Pool } from "pg";
import type { ModelContextItem } from "../../contracts/v1/index.js";
import type {
  EmbeddingProvider,
  MetricsPort,
  VectorStoreProvider,
} from "../../shared/providers/contracts/index.js";

export interface PersonalHistoryRetriever {
  retrieve(input: {
    personId: string;
    conversationId: string;
    query: string;
  }): Promise<readonly ModelContextItem[]>;
}

interface QueryEmbeddingProvider extends EmbeddingProvider {
  embedQuery?(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]>;
}

export function createHybridHistoryRetriever(options: {
  pool: Pool;
  embeddings: EmbeddingProvider;
  vectorStore: VectorStoreProvider;
  metrics?: MetricsPort;
  candidateLimit?: number;
  resultLimit?: number;
}): PersonalHistoryRetriever {
  const candidateLimit = options.candidateLimit ?? 24;
  const resultLimit = options.resultLimit ?? 8;
  return {
    async retrieve({ personId, conversationId, query }) {
      const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 30) ?? [];
      const tsQuery = terms.join(" | ");
      const lexicalPromise = options.pool.query<{
        id: string;
        score: number;
      }>(
        `SELECT m.id, CASE WHEN c.id=$3 THEN 2.0 ELSE ts_rank(m.search_vector, to_tsquery('english',$2)) END AS score
         FROM message m JOIN conversation c ON c.id=m.conversation_id
         WHERE c.owner_person_id=$1 AND c.scope='personal' AND c.status='active'
           AND m.status='active' AND (c.id=$3 OR ($2 <> '' AND m.search_vector @@ to_tsquery('english',$2)))
         ORDER BY score DESC, m.created_at DESC LIMIT $4`,
        [personId, tsQuery, conversationId, candidateLimit],
      );
      let vectorCandidates: readonly { id: string; score: number }[] = [];
      try {
        const [queryVector] = await ((
          options.embeddings as QueryEmbeddingProvider
        ).embedQuery?.([query]) ?? options.embeddings.embed([query]));
        if (queryVector) {
          vectorCandidates = await options.vectorStore.search(
            queryVector,
            { scope: "personal", scopeId: personId, status: "active" },
            candidateLimit,
          );
        }
      } catch {
        // Semantic recall is optional; PostgreSQL remains the fallback source.
        options.metrics?.increment("semantic_retrieval_degraded_total", {
          dependency: "embedding_or_vector_store",
        });
      }
      const lexical = await lexicalPromise;
      const ranked = new Map<string, number>();
      lexical.rows.forEach((row, index) =>
        ranked.set(row.id, 2 + row.score + 1 / (index + 1)),
      );
      vectorCandidates.forEach((candidate, index) => {
        ranked.set(
          candidate.id,
          Math.max(
            ranked.get(candidate.id) ?? 0,
            1 + candidate.score + 1 / (index + 1),
          ),
        );
      });
      const ids = [...ranked.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, candidateLimit)
        .map(([id]) => id);
      if (!ids.length) return [];
      const hydrated = await options.pool.query<{
        id: string;
        content: string;
        created_at: Date;
      }>(
        `SELECT m.id, m.content, m.created_at FROM message m
         JOIN conversation c ON c.id=m.conversation_id
         WHERE m.id=ANY($2::uuid[]) AND m.status='active' AND m.content IS NOT NULL
           AND c.owner_person_id=$1 AND c.scope='personal' AND c.status='active'`,
        [personId, ids],
      );
      const byId = new Map(hydrated.rows.map((row) => [row.id, row]));
      return ids
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .slice(0, resultLimit)
        .map((row) => ({
          content: row.content.slice(0, 1_000),
          createdAt: row.created_at.toISOString(),
        }));
    },
  };
}
