import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { parseRateLimitEventQuery } from "../../../contracts/v1/index.js";
import { decodeCursor, encodeCursor } from "../../../contracts/pagination.js";
import {
  apiErrorStatus,
  type ApiErrorCode,
} from "../../../shared/api-errors/index.js";
import {
  buildActorContext,
  type ActorContext,
} from "../../../shared/authz-contracts/index.js";

export interface AdminOperationsStatus {
  model: "configured" | "not_configured";
  webSearch: "configured" | "not_configured";
  embeddings: "configured" | "not_configured";
  vectorStore: "configured" | "not_configured";
  backup: "configured" | "not_reported";
}

export interface AdminOperationsOptions {
  pool: Pool;
  sessionCookieName: string;
  cursorSigningSecret: string;
  status: AdminOperationsStatus;
}

interface AuthenticatedActor {
  actor: ActorContext;
  mfaVerified: boolean;
}

type EventRoute = "rate-limit-events" | "security-events";

export function createAdminOperationsHandler(options: AdminOperationsOptions) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<boolean> => {
    const path = url.pathname;
    const isOverview = path === "/api/v1/admin/overview";
    const eventRoute: EventRoute | undefined =
      path === "/api/v1/admin/rate-limit-events"
        ? "rate-limit-events"
        : path === "/api/v1/admin/security-events"
          ? "security-events"
          : undefined;
    if (!isOverview && !eventRoute) return false;

    try {
      if (request.method !== "GET")
        return fail(response, requestId, "METHOD_NOT_ALLOWED");
      const authenticated = await authenticate(request, options);
      if (!authenticated) return fail(response, requestId, "UNAUTHENTICATED");
      if (authenticated.actor.isPlatformAdmin && !authenticated.mfaVerified) {
        return fail(response, requestId, "FORBIDDEN");
      }

      if (isOverview) {
        if ([...url.searchParams.keys()].length)
          return fail(response, requestId, "VALIDATION_FAILED");
        const overview = await getOverview(options, authenticated.actor);
        return send(response, 200, overview);
      }

      if (!authenticated.actor.isPlatformAdmin)
        return fail(response, requestId, "FORBIDDEN");
      const query = parseEventQuery(
        url,
        options.cursorSigningSecret,
        eventRoute!,
      );
      if (!query) return fail(response, requestId, "VALIDATION_FAILED");
      const events =
        eventRoute === "rate-limit-events"
          ? await getRateLimitEvents(options, query)
          : await getSecurityEvents(options, query);
      return send(response, 200, events);
    } catch (error) {
      if (error instanceof AuthorizationError)
        return fail(response, requestId, "FORBIDDEN");
      if (!response.headersSent)
        return fail(response, requestId, "DEPENDENCY_UNAVAILABLE", true);
      response.destroy();
      return true;
    }
  };
}

async function authenticate(
  request: IncomingMessage,
  options: AdminOperationsOptions,
): Promise<AuthenticatedActor | undefined> {
  const token = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${options.sessionCookieName}=`))
    ?.slice(options.sessionCookieName.length + 1);
  if (!token || token.length > 512) return undefined;
  const result = await options.pool.query<{
    person_id: string;
    mfa_verified: boolean;
    is_platform_admin: boolean;
    company_id: string | null;
    company_role: "member" | "company_admin" | null;
    workspace_id: string | null;
    workspace_company_id: string | null;
    workspace_role: "member" | "workspace_admin" | null;
  }>(
    `SELECT s.person_id,s.mfa_verified,(pa.person_id IS NOT NULL) AS is_platform_admin,
       cm.company_id,cm.role AS company_role,wm.workspace_id,
       wm.company_id AS workspace_company_id,wm.role AS workspace_role
     FROM session s
     LEFT JOIN platform_admin_assignment pa ON pa.person_id=s.person_id
     LEFT JOIN company_membership cm ON cm.person_id=s.person_id
     LEFT JOIN workspace_membership wm ON wm.person_id=s.person_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL
       AND s.idle_expires_at>now() AND s.absolute_expires_at>now()`,
    [createHash("sha256").update(token).digest("hex")],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const actor = buildActorContext({
    personId: row.person_id,
    platformAdmin: row.is_platform_admin,
    ...(row.company_id && row.company_role
      ? {
          companyMembership: {
            companyId: row.company_id,
            role: row.company_role,
          },
        }
      : {}),
    ...(row.workspace_id && row.workspace_company_id && row.workspace_role
      ? {
          workspaceMembership: {
            companyId: row.workspace_company_id,
            workspaceId: row.workspace_id,
            role: row.workspace_role,
          },
        }
      : {}),
  });
  return { actor, mfaVerified: row.mfa_verified };
}

async function getOverview(
  options: AdminOperationsOptions,
  actor: ActorContext,
): Promise<Record<string, unknown>> {
  if (actor.isPlatformAdmin) {
    const [people, companies, workspaces, conversations, messages] =
      await Promise.all([
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM person",
        ),
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM company WHERE status='active'",
        ),
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspace WHERE status='active'",
        ),
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM conversation WHERE status='active'",
        ),
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM message WHERE status='active'",
        ),
      ]);
    return {
      scope: "platform",
      health: { database: "available", service: "available" },
      providers: {
        model: options.status.model,
        webSearch: options.status.webSearch,
        embeddings: options.status.embeddings,
        vectorStore: options.status.vectorStore,
      },
      backup: { status: options.status.backup },
      usage: {
        people: integer(people.rows[0]?.count),
        activeCompanies: integer(companies.rows[0]?.count),
        activeWorkspaces: integer(workspaces.rows[0]?.count),
        activeConversations: integer(conversations.rows[0]?.count),
        activeMessages: integer(messages.rows[0]?.count),
      },
    };
  }

  const company = actor.companyMembership;
  const workspace = actor.workspaceMembership;
  if (company?.role === "company_admin" && company.companyId) {
    const [companyResult, workspaceCounts, memberCount, usage] =
      await Promise.all([
        options.pool.query<{ id: string; name: string; status: string }>(
          "SELECT id,name,status FROM company WHERE id=$1 AND status='active'",
          [company.companyId],
        ),
        options.pool.query<{ total: string; active: string }>(
          `SELECT count(*)::text AS total,
             count(*) FILTER (WHERE status='active')::text AS active
           FROM workspace WHERE company_id=$1`,
          [company.companyId],
        ),
        options.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM company_membership WHERE company_id=$1",
          [company.companyId],
        ),
        options.pool.query<{ conversations: string; messages: string }>(
          `SELECT count(DISTINCT c.id)::text AS conversations,
             count(m.id)::text AS messages
           FROM workspace w
           LEFT JOIN conversation c ON c.workspace_id=w.id AND c.status='active'
           LEFT JOIN message m ON m.conversation_id=c.id AND m.status='active'
           WHERE w.company_id=$1`,
          [company.companyId],
        ),
      ]);
    const companyRow = companyResult.rows[0];
    if (!companyRow) throw new Error("Company aggregate unavailable");
    return {
      scope: "company",
      company: companyRow,
      workspaces: {
        total: integer(workspaceCounts.rows[0]?.total),
        active: integer(workspaceCounts.rows[0]?.active),
      },
      members: integer(memberCount.rows[0]?.count),
      usage: {
        activeConversations: integer(usage.rows[0]?.conversations),
        activeMessages: integer(usage.rows[0]?.messages),
      },
    };
  }

  if (
    workspace?.role === "workspace_admin" &&
    workspace.workspaceId &&
    workspace.companyId
  ) {
    const [workspaceResult, memberCount, usage] = await Promise.all([
      options.pool.query<{
        id: string;
        companyId: string;
        name: string;
        status: string;
      }>(
        "SELECT id,company_id AS \"companyId\",name,status FROM workspace WHERE id=$1 AND company_id=$2 AND status='active'",
        [workspace.workspaceId, workspace.companyId],
      ),
      options.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workspace_membership WHERE workspace_id=$1 AND company_id=$2",
        [workspace.workspaceId, workspace.companyId],
      ),
      options.pool.query<{ conversations: string; messages: string }>(
        `SELECT count(DISTINCT c.id)::text AS conversations,count(m.id)::text AS messages
         FROM conversation c LEFT JOIN message m ON m.conversation_id=c.id AND m.status='active'
         WHERE c.workspace_id=$1 AND c.status='active'`,
        [workspace.workspaceId],
      ),
    ]);
    const workspaceRow = workspaceResult.rows[0];
    if (!workspaceRow) throw new Error("Workspace aggregate unavailable");
    return {
      scope: "workspace",
      workspace: workspaceRow,
      members: integer(memberCount.rows[0]?.count),
      usage: {
        activeConversations: integer(usage.rows[0]?.conversations),
        activeMessages: integer(usage.rows[0]?.messages),
      },
    };
  }
  throw new AuthorizationError();
}

interface EventQuery {
  limit: number;
  rule?: string;
  cursor?: { id: string; createdAt: string };
}

function parseEventQuery(
  url: URL,
  cursorSigningSecret: string,
  route: EventRoute,
): EventQuery | undefined {
  const allowed = new Set(["limit", "cursor", "rule"]);
  const input: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || input[key] !== undefined) return undefined;
    if (route === "security-events" && key === "rule") return undefined;
    input[key] = value;
  }
  try {
    const query = parseRateLimitEventQuery(input);
    const cursor = query.cursor
      ? decodeCursor(
          query.cursor,
          route === "rate-limit-events"
            ? `platform:admin-events:${query.rule ?? "*"}`
            : "platform:security-events",
          cursorSigningSecret,
        )
      : undefined;
    return {
      limit: query.limit,
      ...(query.rule ? { rule: query.rule } : {}),
      ...(cursor ? { cursor } : {}),
    };
  } catch {
    return undefined;
  }
}

async function getRateLimitEvents(
  options: AdminOperationsOptions,
  query: EventQuery,
): Promise<Record<string, unknown>> {
  const cursor = query.cursor;
  const result = await options.pool.query<{
    id: string;
    rule: string;
    route: string;
    request_id: string;
    occurred_at: Date;
    occurred_at_cursor: string;
    person_id: string | null;
    company_id: string | null;
    workspace_id: string | null;
    subject_hash: string | null;
  }>(
    `SELECT id,rule,route,request_id,occurred_at,
       to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_cursor,
       person_id,company_id,workspace_id,subject_hash
     FROM rate_limit_event
     WHERE ($1::text IS NULL OR rule=$1)
       AND ($2::timestamptz IS NULL OR occurred_at<$2 OR (occurred_at=$2 AND id<$3::uuid))
     ORDER BY occurred_at DESC,id DESC LIMIT $4`,
    [
      query.rule ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      query.limit + 1,
    ],
  );
  const hasMore = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      id: row.id,
      rule: row.rule,
      route: row.route,
      requestId: row.request_id,
      occurredAt: row.occurred_at.toISOString(),
      outcome: "throttled",
      ...(row.person_id ? { personId: row.person_id } : {}),
      ...(row.company_id ? { companyId: row.company_id } : {}),
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(row.subject_hash ? { subjectHash: row.subject_hash.trim() } : {}),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor(
            { id: last.id, createdAt: last.occurred_at_cursor },
            `platform:admin-events:${query.rule ?? "*"}`,
            options.cursorSigningSecret,
          )
        : null,
  };
}

async function getSecurityEvents(
  options: AdminOperationsOptions,
  query: EventQuery,
): Promise<Record<string, unknown>> {
  const cursor = query.cursor;
  const result = await options.pool.query<{
    id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    company_id: string | null;
    workspace_id: string | null;
    request_id: string;
    outcome: "succeeded" | "denied";
    occurred_at: Date;
    occurred_at_cursor: string;
  }>(
    `SELECT id,action,target_type,target_id,company_id,workspace_id,request_id,outcome,occurred_at,
       to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_cursor
     FROM admin_audit_event
     WHERE ($1::timestamptz IS NULL OR occurred_at<$1 OR (occurred_at=$1 AND id<$2::uuid))
     ORDER BY occurred_at DESC,id DESC LIMIT $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1],
  );
  const hasMore = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      companyId: row.company_id,
      workspaceId: row.workspace_id,
      requestId: row.request_id,
      outcome: row.outcome,
      occurredAt: row.occurred_at.toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor(
            { id: last.id, createdAt: last.occurred_at_cursor },
            "platform:security-events",
            options.cursorSigningSecret,
          )
        : null,
  };
}

function integer(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

class AuthorizationError extends Error {}
function send(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
  response.end(JSON.stringify(body));
  return true;
}

function fail(
  response: ServerResponse,
  requestId: string,
  code: ApiErrorCode,
  retryable = false,
  fieldErrors?: unknown,
): true {
  const messages: Partial<Record<ApiErrorCode, string>> = {
    VALIDATION_FAILED: "Request validation failed",
    UNAUTHENTICATED: "Authentication is required",
    FORBIDDEN: "This operation is not permitted",
    METHOD_NOT_ALLOWED: "Method not allowed",
    DEPENDENCY_UNAVAILABLE: "Service temporarily unavailable",
  };
  response.writeHead(apiErrorStatus(code), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
  response.end(
    JSON.stringify({
      error: {
        code,
        message: messages[code] ?? "Request failed",
        requestId,
        retryable,
        ...(Array.isArray(fieldErrors) && fieldErrors.length
          ? { fieldErrors }
          : {}),
      },
    }),
  );
  return true;
}
