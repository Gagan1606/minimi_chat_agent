import type {
  VectorCandidate,
  VectorSearchFilter,
  VectorStoreProvider,
  VectorRecord,
} from "../../shared/providers/contracts/index.js";

export interface QdrantOptions {
  baseUrl: string;
  collection: string;
  dimensions: number;
  metric?: "cosine" | "dot" | "euclid";
  timeoutMs?: number;
  apiKey?: string;
  fetcher?: typeof fetch;
}

export function createQdrantVectorStore(options: QdrantOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const collectionPath = `/collections/${encodeURIComponent(options.collection)}`;
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_000;
  let initialized = false;

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(options.apiKey ? { "api-key": options.apiKey } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!response.ok)
        throw new Error(`Qdrant request failed (${response.status})`);
      if (response.status === 204) return undefined;
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const provider: VectorStoreProvider & {
    initialize(): Promise<void>;
    dropCollection(): Promise<void>;
  } = {
    async initialize() {
      const existing = await fetcher(`${baseUrl}${collectionPath}`, {
        headers: options.apiKey ? { "api-key": options.apiKey } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (existing.ok) {
        initialized = true;
        return;
      }
      if (existing.status !== 404)
        throw new Error(`Qdrant collection check failed (${existing.status})`);
      try {
        await request(collectionPath, {
          method: "PUT",
          body: JSON.stringify({
            vectors: {
              size: options.dimensions,
              distance:
                options.metric === "dot"
                  ? "Dot"
                  : options.metric === "euclid"
                    ? "Euclid"
                    : "Cosine",
            },
          }),
        });
      } catch (error) {
        const verified = await fetcher(`${baseUrl}${collectionPath}`, {
          headers: options.apiKey ? { "api-key": options.apiKey } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!verified.ok) throw error;
      }
      initialized = true;
    },
    async upsert(records: readonly VectorRecord[]) {
      if (records.length === 0) return;
      if (!initialized) await provider.initialize();
      await request(`${collectionPath}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({
          points: records.map((record) => ({
            id: record.id,
            vector: record.vector,
            payload: record.metadata,
          })),
        }),
      });
    },
    async search(
      vector: readonly number[],
      filter: VectorSearchFilter,
      limit: number,
    ) {
      const must: Array<Record<string, unknown>> = [
        { key: "scope", match: { value: filter.scope } },
        { key: "scopeId", match: { value: filter.scopeId } },
        { key: "status", match: { value: filter.status ?? "active" } },
      ];
      if (filter.createdAfter)
        must.push({ key: "createdAt", range: { gte: filter.createdAfter } });
      if (filter.createdBefore)
        must.push({ key: "createdAt", range: { lte: filter.createdBefore } });
      const result = (await request(`${collectionPath}/points/search`, {
        method: "POST",
        body: JSON.stringify({
          vector,
          limit,
          with_payload: false,
          filter: { must },
        }),
      })) as { result?: Array<{ id: string | number; score: number }> };
      return (result.result ?? []).map((candidate): VectorCandidate => ({
        id: String(candidate.id),
        score: candidate.score,
      }));
    },
    async delete(ids: readonly string[]) {
      if (ids.length === 0) return;
      await request(`${collectionPath}/points/delete?wait=true`, {
        method: "POST",
        body: JSON.stringify({ points: ids }),
      });
    },
    async dropCollection() {
      await request(collectionPath, { method: "DELETE" });
    },
  };
  return provider;
}
