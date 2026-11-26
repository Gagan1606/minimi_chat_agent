import type {
  ModelProvider,
  SearchResult,
  WebSearchProvider,
} from "../../../providers/types.js";
import type {
  VectorMetadata,
  VectorSearchFilterSchema,
} from "../../../contracts/v1/index.js";
import type { z } from "zod";

export type { ModelProvider, SearchResult, WebSearchProvider };
export type VectorSearchFilter = z.infer<typeof VectorSearchFilterSchema>;

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata: VectorMetadata;
}

export interface VectorCandidate {
  readonly id: string;
  readonly score: number;
}

export interface VectorStoreProvider {
  upsert(records: readonly VectorRecord[]): Promise<void>;
  search(
    vector: readonly number[],
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<readonly VectorCandidate[]>;
  delete(ids: readonly string[]): Promise<void>;
}

export interface MetricLabels {
  route?: string;
  status?: string;
  provider?: string;
  dependency?: string;
  outcome?: string;
}

export interface MetricsPort {
  increment(name: string, labels?: MetricLabels, value?: number): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

export interface AuditEventInput {
  readonly actorPersonId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly companyId: string | null;
  readonly workspaceId: string | null;
  readonly requestId: string;
  readonly outcome: "succeeded" | "denied";
}

export interface AuditEventPort {
  record(event: AuditEventInput): Promise<void>;
}
