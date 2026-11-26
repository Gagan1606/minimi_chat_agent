import { tavily } from "@tavily/core";
import type { SearchResult, WebSearchProvider } from "./types.js";

export interface TavilyEnvironment {
  WEB_SEARCH_API_KEY?: string;
  WEB_SEARCH_TIMEOUT_MS?: string;
}

interface TavilyRawResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  publishedDate?: string;
}

export interface TavilyClientLike {
  search(
    query: string,
    options: {
      maxResults: number;
      searchDepth: "basic";
      topic: "general";
      timeout: number;
    },
  ): Promise<{ results?: TavilyRawResult[] }>;
}

const MAX_RESULTS = 10;

export function createTavilyWebSearch(
  environment: TavilyEnvironment,
  injectedClient?: TavilyClientLike,
): WebSearchProvider {
  const apiKey = environment.WEB_SEARCH_API_KEY?.trim();
  const configuredTimeout = Number(environment.WEB_SEARCH_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 4_000;
  if (!apiKey && !injectedClient)
    throw new Error("WEB_SEARCH_API_KEY is required");

  const client =
    injectedClient ?? (tavily({ apiKey }) as unknown as TavilyClientLike);

  return {
    async search(query, maxResults = 5): Promise<SearchResult[]> {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) throw new Error("Search query must not be empty");
      const boundedMaxResults = Number.isFinite(maxResults)
        ? Math.min(MAX_RESULTS, Math.max(1, Math.trunc(maxResults)))
        : 5;

      const response = await client.search(normalizedQuery, {
        maxResults: boundedMaxResults,
        searchDepth: "basic",
        topic: "general",
        timeout: timeoutMs,
      });

      return (response.results ?? []).flatMap((result) => {
        const title = result.title?.trim();
        const content = result.content?.trim();
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(result.url ?? "");
        } catch {
          return [];
        }
        if (
          !title ||
          !content ||
          (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
        ) {
          return [];
        }

        return [
          {
            title,
            url: parsedUrl.toString(),
            content,
            ...(typeof result.score === "number" &&
            Number.isFinite(result.score)
              ? { score: result.score }
              : {}),
            ...(result.publishedDate
              ? { publishedDate: result.publishedDate }
              : {}),
          },
        ];
      });
    },
  };
}
