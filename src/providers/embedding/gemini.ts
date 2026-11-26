import { GoogleGenAI } from "@google/genai";
import type { EmbeddingProvider } from "../../shared/providers/contracts/index.js";

interface GeminiEmbeddingClient {
  models: {
    embedContent(input: {
      model: string;
      contents: Array<{ parts: Array<{ text: string }> }>;
      config: { taskType: string; outputDimensionality: number };
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  timeoutMs?: number;
  client?: GeminiEmbeddingClient;
}

export function createGeminiEmbeddingProvider(
  options: GeminiEmbeddingOptions,
): EmbeddingProvider & {
  embedQuery(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
} {
  const client =
    options.client ??
    (new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        timeout: options.timeoutMs ?? 2_000,
        retryOptions: { attempts: 1 },
      },
    }) as unknown as GeminiEmbeddingClient);
  async function embedWithTask(texts: readonly string[], taskType: string) {
    if (texts.some((text) => !text.trim()))
      throw new Error("Embedding input must not be empty");
    if (!texts.length) return [];
    const response = await client.models.embedContent({
      model: options.model,
      contents: texts.map((text) => ({ parts: [{ text }] })),
      config: {
        taskType,
        outputDimensionality: options.dimensions,
      },
    });
    const vectors = response.embeddings?.map((embedding) => embedding.values);
    if (
      !vectors ||
      vectors.length !== texts.length ||
      vectors.some(
        (vector) =>
          !vector ||
          vector.length !== options.dimensions ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error("Embedding provider returned invalid vectors");
    }
    return vectors as readonly (readonly number[])[];
  }
  return {
    embed: (texts) => embedWithTask(texts, "RETRIEVAL_DOCUMENT"),
    embedQuery: (texts: readonly string[]) =>
      embedWithTask(texts, "RETRIEVAL_QUERY"),
  };
}
