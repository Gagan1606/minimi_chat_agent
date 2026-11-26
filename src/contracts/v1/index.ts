import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });

export const ChatRequestSchema = z
  .object({
    scope: z.enum(["personal", "workspace"]),
    conversationId: UuidSchema.optional(),
    message: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const CitationSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    accessedAt: TimestampSchema,
    publishedAt: TimestampSchema.nullable().optional(),
  })
  .strict();

export const ChatResponseSchema = z
  .object({
    conversationId: UuidSchema,
    messageId: UuidSchema,
    answer: z.string(),
    citations: z.array(CitationSchema),
    createdAt: TimestampSchema,
  })
  .strict();

export const HistoryScopeSchema = z.enum(["personal", "workspace"]);

export const HistoryQuerySchema = z
  .object({
    scope: HistoryScopeSchema,
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export function parseHistoryQuery(input: unknown): {
  scope: "personal" | "workspace";
  limit: number;
  cursor?: string;
} {
  const query = HistoryQuerySchema.parse(input);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["limit"],
        message: "Limit must be between 1 and 50",
      },
    ]);
  }
  return {
    scope: query.scope,
    limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

export const ConversationSummarySchema = z
  .object({
    id: UuidSchema,
    scope: HistoryScopeSchema,
    title: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ConversationListResponseSchema = z
  .object({
    items: z.array(ConversationSummarySchema).max(50),
    nextCursor: z.string().max(2048).nullable(),
  })
  .strict();

export const MessageResponseSchema = z
  .object({
    id: UuidSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    createdAt: TimestampSchema,
    citations: z.array(CitationSchema).optional(),
  })
  .strict();

export const ConversationDetailResponseSchema = z
  .object({
    id: UuidSchema,
    scope: HistoryScopeSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    messages: z.array(MessageResponseSchema),
  })
  .strict();

export const DeleteConversationResponseSchema = z
  .object({ id: UuidSchema, deleted: z.literal(true) })
  .strict();

export const DeleteHistoryResponseSchema = z
  .object({ deletedCount: z.number().int().nonnegative() })
  .strict();

export const RemoveMemberResponseSchema = z
  .object({ personId: UuidSchema, removed: z.literal(true) })
  .strict();

export const CreateCompanyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    companyAdminPersonId: UuidSchema,
  })
  .strict();

export const CreateWorkspaceRequestSchema = z
  .object({ name: z.string().trim().min(1).max(160) })
  .strict();

export const AddWorkspaceMemberRequestSchema = z
  .object({ personId: UuidSchema })
  .strict();

export const AddCompanyMemberRequestSchema = z
  .object({ personId: UuidSchema, workspaceId: UuidSchema })
  .strict();

export const AssignCompanyAdminRequestSchema = z
  .object({ personId: UuidSchema })
  .strict();

export const AssignWorkspaceAdminRequestSchema = z
  .object({ personId: UuidSchema })
  .strict();

export const RateLimitEventSchema = z
  .object({
    id: UuidSchema,
    rule: z.string().min(1).max(100),
    route: z.string().min(1).max(200),
    requestId: UuidSchema,
    occurredAt: TimestampSchema,
    outcome: z.literal("throttled"),
    personId: UuidSchema.optional(),
    companyId: UuidSchema.optional(),
    workspaceId: UuidSchema.optional(),
    subjectHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const RateLimitEventQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    cursor: z.string().min(1).max(2048).optional(),
    rule: z.string().min(1).max(100).optional(),
  })
  .strict();

export function parseRateLimitEventQuery(input: unknown): {
  limit: number;
  cursor?: string;
  rule?: string;
} {
  const query = RateLimitEventQuerySchema.parse(input);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["limit"],
        message: "Limit must be between 1 and 50",
      },
    ]);
  }
  return {
    limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.rule === undefined ? {} : { rule: query.rule }),
  };
}

export const RateLimitEventPageSchema = z
  .object({
    items: z.array(RateLimitEventSchema).max(50),
    nextCursor: z.string().max(2048).nullable(),
  })
  .strict();

export const CompanyResponseSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    status: z.enum(["active", "suspended"]),
    createdAt: TimestampSchema,
  })
  .strict();

export const WorkspaceResponseSchema = z
  .object({
    id: UuidSchema,
    companyId: UuidSchema,
    name: z.string(),
    status: z.enum(["active", "archived"]),
    createdAt: TimestampSchema,
  })
  .strict();

export const CompanyMembershipResponseSchema = z
  .object({
    personId: UuidSchema,
    companyId: UuidSchema,
    role: z.enum(["member", "company_admin"]),
  })
  .strict();

export const WorkspaceMembershipResponseSchema = z
  .object({
    personId: UuidSchema,
    workspaceId: UuidSchema,
    role: z.enum(["member", "workspace_admin"]),
  })
  .strict();

export const HealthResponseSchema = z
  .object({ status: z.enum(["ok", "ready"]) })
  .strict();

export const ModelContextItemSchema = z
  .object({ content: z.string().min(1), createdAt: TimestampSchema })
  .strict();

export const VectorMetadataSchema = z
  .object({
    scope: HistoryScopeSchema,
    scopeId: UuidSchema,
    status: z.enum(["active", "deleted"]),
    createdAt: TimestampSchema,
  })
  .strict();

export const VectorSearchFilterSchema = z
  .object({
    scope: HistoryScopeSchema,
    scopeId: UuidSchema,
    status: z.literal("active").default("active"),
    createdAfter: TimestampSchema.optional(),
    createdBefore: TimestampSchema.optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type HistoryScope = z.infer<typeof HistoryScopeSchema>;
export type ModelContextItem = z.infer<typeof ModelContextItemSchema>;
export type VectorMetadata = z.infer<typeof VectorMetadataSchema>;
export type RateLimitEventPage = z.infer<typeof RateLimitEventPageSchema>;
