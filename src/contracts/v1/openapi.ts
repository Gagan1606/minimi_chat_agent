import { z } from "zod";
import {
  AddWorkspaceMemberRequestSchema,
  AddCompanyMemberRequestSchema,
  AssignCompanyAdminRequestSchema,
  AssignWorkspaceAdminRequestSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  CompanyMembershipResponseSchema,
  CompanyResponseSchema,
  ConversationDetailResponseSchema,
  ConversationListResponseSchema,
  CreateCompanyRequestSchema,
  CreateWorkspaceRequestSchema,
  DeleteConversationResponseSchema,
  DeleteHistoryResponseSchema,
  HealthResponseSchema,
  RateLimitEventSchema,
  RateLimitEventPageSchema,
  RemoveMemberResponseSchema,
  WorkspaceMembershipResponseSchema,
  WorkspaceResponseSchema,
} from "./index.js";
import { ApiErrorEnvelopeSchema } from "../../shared/api-errors/index.js";

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

const csrfHeader = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 32 },
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 200 },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Momos API",
    version: "1.0.0",
    description:
      "Versioned API contracts. Authorization scope is derived from the authenticated session; request bodies never grant roles or tenant membership.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/health/live": {
      get: {
        operationId: "getLiveHealth",
        responses: { "200": response("Live health", "HealthResponse") },
      },
    },
    "/health/ready": {
      get: {
        operationId: "getReadyHealth",
        responses: {
          "200": response("Ready health", "HealthResponse"),
          "503": response("Dependency unavailable", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/chat": {
      post: {
        operationId: "createChatTurn",
        security: [{ sessionCookie: [] }],
        parameters: [idempotencyHeader],
        requestBody: requestBody("ChatRequest"),
        responses: {
          "200": response("Chat turn", "ChatResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "409": response("Idempotency conflict", "ApiErrorEnvelope"),
          "422": response("Invalid input", "ApiErrorEnvelope"),
          "429": response("Rate limited", "ApiErrorEnvelope"),
          "503": response("Dependency unavailable", "ApiErrorEnvelope"),
          "504": response("Provider deadline exceeded", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/conversations": {
      get: {
        operationId: "listConversations",
        security: [{ sessionCookie: [] }],
        parameters: [
          queryParameter("scope", "personal or workspace", true),
          queryParameter("limit", "Page size, 1 to 50; defaults to 50", false),
          queryParameter(
            "cursor",
            "Opaque scope-bound pagination cursor",
            false,
          ),
        ],
        responses: {
          "200": response("Conversation page", "ConversationListResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "422": response("Invalid input", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/conversations/{conversationId}": {
      get: {
        operationId: "getConversation",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("conversationId")],
        responses: {
          "200": response("Conversation detail", "ConversationDetailResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "404": response("Not found or out of scope", "ApiErrorEnvelope"),
        },
      },
      delete: {
        operationId: "deleteConversation",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("conversationId"), csrfHeader],
        responses: {
          "200": response("Deletion result", "DeleteConversationResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "404": response("Not found or out of scope", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/me/history": {
      delete: {
        operationId: "deleteMyHistory",
        security: [{ sessionCookie: [] }],
        parameters: [csrfHeader],
        responses: {
          "200": response("Deletion result", "DeleteHistoryResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/platform/companies": {
      post: {
        operationId: "createCompany",
        security: [{ sessionCookie: [] }],
        parameters: [idempotencyHeader, csrfHeader],
        requestBody: requestBody("CreateCompanyRequest"),
        responses: {
          "201": response("Company created", "CompanyResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "422": response("Invalid input", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/companies/{companyId}/workspaces": {
      post: {
        operationId: "createWorkspace",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("companyId"), idempotencyHeader, csrfHeader],
        requestBody: requestBody("CreateWorkspaceRequest"),
        responses: {
          "201": response("Workspace created", "WorkspaceResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response(
            "Company not found or out of scope",
            "ApiErrorEnvelope",
          ),
          "422": response("Invalid input", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/workspaces/{workspaceId}/members": {
      post: {
        operationId: "addWorkspaceMember",
        security: [{ sessionCookie: [] }],
        parameters: [
          pathParameter("workspaceId"),
          idempotencyHeader,
          csrfHeader,
        ],
        requestBody: requestBody("AddWorkspaceMemberRequest"),
        responses: {
          "201": response(
            "Workspace member added",
            "WorkspaceMembershipResponse",
          ),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response(
            "Workspace not found or out of scope",
            "ApiErrorEnvelope",
          ),
          "422": response("Invalid input", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/companies/{companyId}/members": {
      post: {
        operationId: "addCompanyMember",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("companyId"), idempotencyHeader, csrfHeader],
        requestBody: requestBody("AddCompanyMemberRequest"),
        responses: {
          "201": response(
            "Company member added to workspace",
            "WorkspaceMembershipResponse",
          ),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response(
            "Company, person, or workspace not found",
            "ApiErrorEnvelope",
          ),
          "422": response("Invalid input", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/companies/{companyId}/members/{personId}": {
      delete: {
        operationId: "removeCompanyMember",
        security: [{ sessionCookie: [] }],
        parameters: [
          pathParameter("companyId"),
          pathParameter("personId"),
          csrfHeader,
        ],
        responses: {
          "200": response("Company member removed", "RemoveMemberResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response("Company or member not found", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/workspaces/{workspaceId}/members/{personId}": {
      delete: {
        operationId: "removeWorkspaceMember",
        security: [{ sessionCookie: [] }],
        parameters: [
          pathParameter("workspaceId"),
          pathParameter("personId"),
          csrfHeader,
        ],
        responses: {
          "200": response("Workspace member removed", "RemoveMemberResponse"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response("Workspace or member not found", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/companies/{companyId}/company-admin": {
      put: {
        operationId: "assignCompanyAdmin",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("companyId"), csrfHeader],
        requestBody: requestBody("AssignCompanyAdminRequest"),
        responses: {
          "200": response(
            "Company Admin assigned",
            "CompanyMembershipResponse",
          ),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response("Company or person not found", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/workspaces/{workspaceId}/workspace-admin": {
      put: {
        operationId: "assignWorkspaceAdmin",
        security: [{ sessionCookie: [] }],
        parameters: [pathParameter("workspaceId"), csrfHeader],
        requestBody: requestBody("AssignWorkspaceAdminRequest"),
        responses: {
          "200": response(
            "Workspace Admin assigned",
            "WorkspaceMembershipResponse",
          ),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
          "404": response("Workspace or person not found", "ApiErrorEnvelope"),
        },
      },
    },
    "/api/v1/platform/rate-limit-events": {
      get: {
        operationId: "listRateLimitEvents",
        security: [{ sessionCookie: [] }],
        parameters: [
          queryParameter("limit", "Page size, 1 to 50; defaults to 50", false),
          queryParameter(
            "cursor",
            "Opaque scope-bound pagination cursor",
            false,
          ),
          queryParameter("rule", "Exact rule filter", false),
        ],
        responses: {
          "200": response("Rate-limit event page", "RateLimitEventPage"),
          "401": response("Unauthenticated", "ApiErrorEnvelope"),
          "403": response("Forbidden", "ApiErrorEnvelope"),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "momos_session" },
    },
    schemas: {
      ChatRequest: jsonSchema(ChatRequestSchema),
      ChatResponse: jsonSchema(ChatResponseSchema),
      ConversationListResponse: jsonSchema(ConversationListResponseSchema),
      ConversationDetailResponse: jsonSchema(ConversationDetailResponseSchema),
      DeleteConversationResponse: jsonSchema(DeleteConversationResponseSchema),
      DeleteHistoryResponse: jsonSchema(DeleteHistoryResponseSchema),
      CreateCompanyRequest: jsonSchema(CreateCompanyRequestSchema),
      CreateWorkspaceRequest: jsonSchema(CreateWorkspaceRequestSchema),
      AddWorkspaceMemberRequest: jsonSchema(AddWorkspaceMemberRequestSchema),
      AddCompanyMemberRequest: jsonSchema(AddCompanyMemberRequestSchema),
      AssignCompanyAdminRequest: jsonSchema(AssignCompanyAdminRequestSchema),
      AssignWorkspaceAdminRequest: jsonSchema(
        AssignWorkspaceAdminRequestSchema,
      ),
      HealthResponse: jsonSchema(HealthResponseSchema),
      RateLimitEvent: jsonSchema(RateLimitEventSchema),
      RateLimitEventPage: jsonSchema(RateLimitEventPageSchema),
      CompanyResponse: jsonSchema(CompanyResponseSchema),
      WorkspaceResponse: jsonSchema(WorkspaceResponseSchema),
      CompanyMembershipResponse: jsonSchema(CompanyMembershipResponseSchema),
      WorkspaceMembershipResponse: jsonSchema(
        WorkspaceMembershipResponseSchema,
      ),
      RemoveMemberResponse: jsonSchema(RemoveMemberResponseSchema),
      ApiErrorEnvelope: jsonSchema(ApiErrorEnvelopeSchema),
    },
  },
} as const;

function response(description: string, schema: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function requestBody(schema: string) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function pathParameter(name: string) {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  };
}

function queryParameter(name: string, description: string, required: boolean) {
  return {
    name,
    in: "query",
    required,
    description,
    schema: { type: "string" },
  };
}
