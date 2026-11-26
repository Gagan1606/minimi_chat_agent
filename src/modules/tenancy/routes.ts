import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  AddCompanyMemberRequestSchema,
  AddWorkspaceMemberRequestSchema,
  AssignCompanyAdminRequestSchema,
  AssignWorkspaceAdminRequestSchema,
  CreateCompanyRequestSchema,
  CreateWorkspaceRequestSchema,
} from "../../contracts/v1/index.js";
import {
  buildActorContext,
  canPerform,
  type ActorContext,
} from "../../shared/authz-contracts/index.js";
import {
  apiErrorStatus,
  toFieldErrors,
  type ApiErrorCode,
} from "../../shared/api-errors/index.js";
import { withTransaction } from "../../db/transactions.js";

const UUID = z.string().uuid();
const MAX_BODY = 16_384;
type Options = {
  pool: Pool;
  sessionCookieName: string;
  rateLimitSecret: string;
};
type Route = { method: string; path: string; params: Record<string, string> };
type SessionActor = {
  actor: ActorContext;
  mfaVerified: boolean;
  csrfHash: string;
};

export function createTenancyHandler(options: Options) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<boolean> => {
    let route: Route | undefined;
    try {
      route = matchRoute(request.method ?? "GET", request.url ?? "");
      if (!route) return false;
      response.setHeader("content-type", "application/json; charset=utf-8");
      const session = await authenticate(request, options);
      if (!session)
        throw new HttpError("UNAUTHENTICATED", "Authentication required");
      if (
        route.method !== "GET" &&
        !csrfValid(session.csrfHash, request.headers["x-csrf-token"])
      )
        throw new HttpError("CSRF_FAILED", "CSRF token is invalid");
      if (route.method !== "GET")
        await enforceWriteLimit(options, session.actor, route, requestId);
      const body =
        route.method === "POST" || route.method === "PUT"
          ? await parseBody(request)
          : undefined;
      const result = await dispatch(
        options.pool,
        route,
        request,
        session,
        body,
        requestId,
      );
      response.writeHead(result.status, {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return true;
      }
      const e =
        error instanceof HttpError
          ? error
          : new HttpError("INTERNAL_ERROR", "Request could not be completed");
      response.writeHead(apiErrorStatus(e.code), {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(
        JSON.stringify({
          error: {
            code: e.code,
            message: e.message,
            requestId,
            retryable: e.retryable,
            ...(e.fields ? { fieldErrors: e.fields } : {}),
          },
        }),
      );
    }
    return true;
  };
}

class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: ReturnType<typeof toFieldErrors>,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function matchRoute(method: string, url: string): Route | undefined {
  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
  const patterns: Array<[string, RegExp, string[]]> = [
    ["POST", /^\/api\/v1\/platform\/companies$/, []],
    ["POST", /^\/api\/v1\/companies\/([^/]+)\/workspaces$/, ["companyId"]],
    ["POST", /^\/api\/v1\/companies\/([^/]+)\/members$/, ["companyId"]],
    [
      "DELETE",
      /^\/api\/v1\/companies\/([^/]+)\/members\/([^/]+)$/,
      ["companyId", "personId"],
    ],
    ["PUT", /^\/api\/v1\/companies\/([^/]+)\/company-admin$/, ["companyId"]],
    ["POST", /^\/api\/v1\/workspaces\/([^/]+)\/members$/, ["workspaceId"]],
    [
      "DELETE",
      /^\/api\/v1\/workspaces\/([^/]+)\/members\/([^/]+)$/,
      ["workspaceId", "personId"],
    ],
    [
      "PUT",
      /^\/api\/v1\/workspaces\/([^/]+)\/workspace-admin$/,
      ["workspaceId"],
    ],
  ];
  for (const [expected, regex, names] of patterns) {
    const match = regex.exec(path);
    if (!match) continue;
    if (method !== expected)
      throw new HttpError("METHOD_NOT_ALLOWED", "Method not allowed");
    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    return { method, path, params };
  }
  return undefined;
}

async function authenticate(
  req: IncomingMessage,
  options: Options,
): Promise<SessionActor | undefined> {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${options.sessionCookieName}=`));
  const token = cookie?.slice(options.sessionCookieName.length + 1);
  if (!token || token.length > 512) return undefined;
  const result = await options.pool.query<{
    person_id: string;
    csrf_token_hash: string;
    mfa_verified: boolean;
    is_platform_admin: boolean;
    company_id: string | null;
    company_role: "member" | "company_admin" | null;
    workspace_id: string | null;
    workspace_company_id: string | null;
    workspace_role: "member" | "workspace_admin" | null;
  }>(
    `SELECT s.person_id, s.csrf_token_hash, s.mfa_verified, (pa.person_id IS NOT NULL) AS is_platform_admin,
      cm.company_id, cm.role AS company_role, wm.workspace_id, wm.company_id AS workspace_company_id, wm.role AS workspace_role
     FROM session s LEFT JOIN platform_admin_assignment pa ON pa.person_id=s.person_id
     LEFT JOIN company_membership cm ON cm.person_id=s.person_id LEFT JOIN workspace_membership wm ON wm.person_id=s.person_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()`,
    [sha256(token)],
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
  return {
    actor,
    mfaVerified: row.mfa_verified,
    csrfHash: row.csrf_token_hash,
  };
}

async function dispatch(
  pool: Pool,
  route: Route,
  request: IncomingMessage,
  session: SessionActor,
  rawBody: unknown,
  requestId: string,
): Promise<{ status: number; body: unknown }> {
  const { actor } = session;
  const { companyId, workspaceId, personId } = route.params;
  if (
    (companyId && !UUID.safeParse(companyId).success) ||
    (workspaceId && !UUID.safeParse(workspaceId).success) ||
    (personId && !UUID.safeParse(personId).success)
  )
    throw invalid("Invalid UUID path parameter");
  if (route.method !== "DELETE") validateBody(route.path, rawBody);
  const key = request.headers["idempotency-key"];
  if (
    route.method === "POST" &&
    (typeof key !== "string" || key.length < 1 || key.length > 200)
  )
    throw new HttpError(
      "INVALID_REQUEST",
      "Idempotency-Key header is required",
    );

  if (route.path === "/api/v1/platform/companies") {
    const body = parse(CreateCompanyRequestSchema, rawBody);
    permit(actor, "company.create");
    requireMfa(session);
    return idempotent(
      pool,
      actor.personId,
      "platform",
      key as string,
      { method: route.method, path: route.path, body },
      async (client) => {
        const person = await client.query(
          "SELECT id FROM person WHERE id=$1 FOR UPDATE",
          [body.companyAdminPersonId],
        );
        if (!person.rowCount) throw notFound("Person");
        const id = randomUUID();
        await client.query("INSERT INTO company (id,name) VALUES ($1,$2)", [
          id,
          body.name,
        ]);
        await client.query(
          "INSERT INTO company_membership (person_id,company_id,role) VALUES ($1,$2,'company_admin')",
          [body.companyAdminPersonId, id],
        );
        const row = await client.query<{ created_at: Date }>(
          "SELECT created_at FROM company WHERE id=$1",
          [id],
        );
        await audit(client, {
          actorId: actor.personId,
          action: "company.create",
          targetType: "company",
          targetId: id,
          companyId: id,
          requestId,
        });
        return {
          status: 201,
          type: "company",
          id,
          body: {
            id,
            name: body.name,
            status: "active",
            createdAt: row.rows[0]!.created_at.toISOString(),
          },
        };
      },
    );
  }

  if (route.method === "POST" && route.path.endsWith("/workspaces")) {
    const company = await loadCompany(pool, companyId!);
    if (!company) throw notFound("Company");
    permitCompany(actor, "workspace.create", companyId!);
    const body = parse(CreateWorkspaceRequestSchema, rawBody);
    return idempotent(
      pool,
      actor.personId,
      "company",
      key as string,
      { method: route.method, path: route.path, body },
      async (client) => {
        const id = randomUUID();
        await client.query(
          "INSERT INTO workspace (id,company_id,name) VALUES ($1,$2,$3)",
          [id, companyId, body.name],
        );
        const row = await client.query<{ created_at: Date }>(
          "SELECT created_at FROM workspace WHERE id=$1",
          [id],
        );
        await audit(client, {
          actorId: actor.personId,
          action: "workspace.create",
          targetType: "workspace",
          targetId: id,
          companyId,
          requestId,
        });
        return {
          status: 201,
          type: "workspace",
          id,
          body: {
            id,
            companyId,
            name: body.name,
            status: "active",
            createdAt: row.rows[0]!.created_at.toISOString(),
          },
        };
      },
    );
  }

  if (route.method === "PUT" && route.path.endsWith("/company-admin")) {
    const company = await loadCompany(pool, companyId!);
    if (!company) throw notFound("Company");
    ensureTenant(actor, companyId!);
    permit(actor, "company.assign_admin");
    requireMfa(session);
    const body = parse(AssignCompanyAdminRequestSchema, rawBody);
    const result = await withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM company WHERE id=$1 FOR UPDATE", [
        companyId,
      ]);
      const member = await client.query(
        "SELECT person_id FROM company_membership WHERE person_id=$1 AND company_id=$2 FOR UPDATE",
        [body.personId, companyId],
      );
      if (!member.rowCount) throw notFound("Company member");
      await client.query(
        "UPDATE company_membership SET role='member' WHERE company_id=$1 AND role='company_admin'",
        [companyId],
      );
      await client.query(
        "UPDATE company_membership SET role='company_admin' WHERE person_id=$1 AND company_id=$2",
        [body.personId, companyId],
      );
      await audit(client, {
        actorId: actor.personId,
        action: "company.admin.assign",
        targetType: "person",
        targetId: body.personId,
        companyId,
        requestId,
      });
      return { personId: body.personId, companyId, role: "company_admin" };
    });
    return { status: 200, body: result };
  }

  if (route.method === "PUT" && route.path.endsWith("/workspace-admin")) {
    const workspace = await loadWorkspace(pool, workspaceId!);
    if (!workspace) throw notFound("Workspace");
    ensureTenant(actor, workspace.company_id);
    permit(actor, "workspace.assign_admin", {
      companyId: workspace.company_id,
      workspaceId,
    });
    const body = parse(AssignWorkspaceAdminRequestSchema, rawBody);
    const result = await withTransaction(pool, async (client) => {
      await client.query("SELECT id FROM workspace WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
      const member = await client.query(
        "SELECT person_id FROM workspace_membership WHERE person_id=$1 AND workspace_id=$2 FOR UPDATE",
        [body.personId, workspaceId],
      );
      if (!member.rowCount) throw notFound("Workspace member");
      await client.query(
        "UPDATE workspace_membership SET role='member' WHERE workspace_id=$1 AND role='workspace_admin'",
        [workspaceId],
      );
      await client.query(
        "UPDATE workspace_membership SET role='workspace_admin' WHERE person_id=$1 AND workspace_id=$2",
        [body.personId, workspaceId],
      );
      await audit(client, {
        actorId: actor.personId,
        action: "workspace.admin.assign",
        targetType: "person",
        targetId: body.personId,
        companyId: workspace.company_id,
        workspaceId,
        requestId,
      });
      return { personId: body.personId, workspaceId, role: "workspace_admin" };
    });
    return { status: 200, body: result };
  }

  if (route.method === "POST" && route.path.endsWith("/members") && companyId) {
    const company = await loadCompany(pool, companyId);
    if (!company) throw notFound("Company");
    permitCompany(actor, "company.members.manage", companyId);
    const body = parse(AddCompanyMemberRequestSchema, rawBody);
    const workspace = await loadWorkspace(pool, body.workspaceId);
    if (!workspace || workspace.company_id !== companyId)
      throw notFound("Workspace");
    return idempotent(
      pool,
      actor.personId,
      "company",
      key as string,
      { method: route.method, path: route.path, body },
      async (client) => {
        const person = await client.query(
          "SELECT id FROM person WHERE id=$1 FOR UPDATE",
          [body.personId],
        );
        if (!person.rowCount) throw notFound("Person");
        const prior = await client.query(
          "SELECT company_id FROM company_membership WHERE person_id=$1 FOR UPDATE",
          [body.personId],
        );
        if (prior.rowCount)
          throw new HttpError(
            "INVALID_REQUEST",
            "Person already belongs to a company",
          );
        await client.query(
          "INSERT INTO company_membership (person_id,company_id,role) VALUES ($1,$2,'member')",
          [body.personId, companyId],
        );
        await client.query(
          "INSERT INTO workspace_membership (person_id,company_id,workspace_id,role) VALUES ($1,$2,$3,'member')",
          [body.personId, companyId, body.workspaceId],
        );
        await audit(client, {
          actorId: actor.personId,
          action: "company.member.add",
          targetType: "person",
          targetId: body.personId,
          companyId,
          workspaceId: body.workspaceId,
          requestId,
        });
        return {
          status: 201,
          type: "workspace_membership",
          id: body.personId,
          body: {
            personId: body.personId,
            workspaceId: body.workspaceId,
            role: "member",
          },
        };
      },
    );
  }

  if (
    route.method === "POST" &&
    route.path.endsWith("/members") &&
    workspaceId
  ) {
    const workspace = await loadWorkspace(pool, workspaceId);
    if (!workspace) throw notFound("Workspace");
    ensureWorkspaceVisible(actor, workspace.company_id, workspaceId);
    permit(actor, "workspace.members.manage", {
      companyId: workspace.company_id,
      workspaceId,
    });
    const body = parse(AddWorkspaceMemberRequestSchema, rawBody);
    return idempotent(
      pool,
      actor.personId,
      "workspace",
      key as string,
      { method: route.method, path: route.path, body },
      async (client) => {
        const member = await client.query(
          "SELECT person_id FROM company_membership WHERE person_id=$1 AND company_id=$2 FOR UPDATE",
          [body.personId, workspace.company_id],
        );
        if (!member.rowCount) throw notFound("Company member");
        const prior = await client.query(
          "SELECT workspace_id FROM workspace_membership WHERE person_id=$1",
          [body.personId],
        );
        if (prior.rowCount)
          throw new HttpError(
            "INVALID_REQUEST",
            "Person already belongs to a workspace",
          );
        await client.query(
          "INSERT INTO workspace_membership (person_id,company_id,workspace_id,role) VALUES ($1,$2,$3,'member')",
          [body.personId, workspace.company_id, workspaceId],
        );
        await audit(client, {
          actorId: actor.personId,
          action: "workspace.member.add",
          targetType: "person",
          targetId: body.personId,
          companyId: workspace.company_id,
          workspaceId,
          requestId,
        });
        return {
          status: 201,
          type: "workspace_membership",
          id: body.personId,
          body: { personId: body.personId, workspaceId, role: "member" },
        };
      },
    );
  }

  if (route.method === "DELETE" && personId && companyId) {
    const company = await loadCompany(pool, companyId);
    if (!company) throw notFound("Company");
    permitCompany(actor, "company.members.manage", companyId);
    await withTransaction(pool, async (client) => {
      const member = await client.query<{ role: string }>(
        "SELECT role FROM company_membership WHERE person_id=$1 AND company_id=$2 FOR UPDATE",
        [personId, companyId],
      );
      if (!member.rowCount) throw notFound("Company member");
      if (member.rows[0]!.role === "company_admin")
        throw new HttpError(
          "INVALID_REQUEST",
          "Assign another Company Admin before removing this member",
        );
      await client.query(
        "DELETE FROM company_membership WHERE person_id=$1 AND company_id=$2",
        [personId, companyId],
      );
      await audit(client, {
        actorId: actor.personId,
        action: "company.member.remove",
        targetType: "person",
        targetId: personId,
        companyId,
        requestId,
      });
    });
    return { status: 200, body: { personId, removed: true } };
  }

  if (route.method === "DELETE" && personId && workspaceId) {
    const workspace = await loadWorkspace(pool, workspaceId);
    if (!workspace) throw notFound("Workspace");
    ensureWorkspaceVisible(actor, workspace.company_id, workspaceId);
    permit(actor, "workspace.members.manage", {
      companyId: workspace.company_id,
      workspaceId,
    });
    await withTransaction(pool, async (client) => {
      const member = await client.query<{ role: string }>(
        "SELECT role FROM workspace_membership WHERE person_id=$1 AND workspace_id=$2 FOR UPDATE",
        [personId, workspaceId],
      );
      if (!member.rowCount) throw notFound("Workspace member");
      if (member.rows[0]!.role === "workspace_admin")
        throw new HttpError(
          "INVALID_REQUEST",
          "Assign another Workspace Admin before removing this member",
        );
      await client.query(
        "DELETE FROM workspace_membership WHERE person_id=$1 AND workspace_id=$2",
        [personId, workspaceId],
      );
      await audit(client, {
        actorId: actor.personId,
        action: "workspace.member.remove",
        targetType: "person",
        targetId: personId,
        companyId: workspace.company_id,
        workspaceId,
        requestId,
      });
    });
    return { status: 200, body: { personId, removed: true } };
  }
  throw notFound("Route");
}

function validateBody(path: string, body: unknown): void {
  if (path === "/api/v1/platform/companies")
    parse(CreateCompanyRequestSchema, body);
  else if (path.endsWith("/workspaces"))
    parse(CreateWorkspaceRequestSchema, body);
  else if (path.endsWith("/company-admin"))
    parse(AssignCompanyAdminRequestSchema, body);
  else if (path.endsWith("/workspace-admin"))
    parse(AssignWorkspaceAdminRequestSchema, body);
  else if (path.includes("/companies/") && path.endsWith("/members"))
    parse(AddCompanyMemberRequestSchema, body);
  else if (path.endsWith("/members"))
    parse(AddWorkspaceMemberRequestSchema, body);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new HttpError(
        "VALIDATION_FAILED",
        "Request validation failed",
        toFieldErrors(error),
      );
    throw error;
  }
}
function invalid(message: string): HttpError {
  return new HttpError("VALIDATION_FAILED", message, [
    { path: "path", code: "invalid_format", message },
  ]);
}
function permit(
  actor: ActorContext,
  action: Parameters<typeof canPerform>[1],
  scope: Parameters<typeof canPerform>[2] = {},
): void {
  if (!canPerform(actor, action, scope))
    throw new HttpError(
      "FORBIDDEN",
      "You are not allowed to perform this action",
    );
}
function ensureTenant(actor: ActorContext, companyId: string): void {
  if (
    !actor.isPlatformAdmin &&
    actor.companyMembership?.companyId !== companyId
  )
    throw notFound("Company");
}
function permitCompany(
  actor: ActorContext,
  action: Parameters<typeof canPerform>[1],
  companyId: string,
): void {
  ensureTenant(actor, companyId);
  permit(actor, action, { companyId });
}
function ensureWorkspaceVisible(
  actor: ActorContext,
  companyId: string,
  workspaceId: string,
): void {
  if (
    actor.isPlatformAdmin ||
    (actor.companyMembership?.companyId === companyId &&
      actor.companyMembership.role === "company_admin")
  )
    return;
  if (
    actor.workspaceMembership?.companyId !== companyId ||
    actor.workspaceMembership.workspaceId !== workspaceId
  )
    throw notFound("Workspace");
}
function requireMfa(session: SessionActor): void {
  if (session.actor.isPlatformAdmin && !session.mfaVerified)
    throw new HttpError("MFA_REQUIRED", "Platform Admin MFA is required");
}
function notFound(resource: string): HttpError {
  return new HttpError("NOT_FOUND", `${resource} not found`);
}
async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY)
      throw new HttpError("INVALID_REQUEST", "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError("INVALID_REQUEST", "Request body must be valid JSON");
  }
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function csrfValid(
  expected: string,
  actual: string | string[] | undefined,
): boolean {
  if (typeof actual !== "string" || actual.length > 512) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sha256(actual));
  return a.length === b.length && timingSafeEqual(a, b);
}
async function loadCompany(
  pool: Pool,
  id: string,
): Promise<{ id: string } | undefined> {
  return (
    await pool.query<{ id: string }>(
      "SELECT id FROM company WHERE id=$1 AND status='active'",
      [id],
    )
  ).rows[0];
}
async function loadWorkspace(
  pool: Pool,
  id: string,
): Promise<{ id: string; company_id: string } | undefined> {
  return (
    await pool.query<{ id: string; company_id: string }>(
      "SELECT id,company_id FROM workspace WHERE id=$1 AND status='active'",
      [id],
    )
  ).rows[0];
}
async function audit(
  client: PoolClient,
  event: {
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    companyId?: string;
    workspaceId?: string;
    requestId: string;
  },
): Promise<void> {
  await client.query(
    "INSERT INTO admin_audit_event (id,actor_person_id,action,target_type,target_id,company_id,workspace_id,request_id,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'succeeded')",
    [
      randomUUID(),
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      event.companyId ?? null,
      event.workspaceId ?? null,
      event.requestId,
    ],
  );
}
type IdempotentResult = {
  status: number;
  type: string;
  id: string;
  body: unknown;
};
async function idempotent(
  pool: Pool,
  principalId: string,
  scope: "platform" | "company" | "workspace",
  key: string,
  input: unknown,
  work: (client: PoolClient) => Promise<IdempotentResult>,
): Promise<IdempotentResult> {
  const hash = sha256(JSON.stringify(input));
  return withTransaction(pool, async (client) => {
    await client.query(
      "DELETE FROM idempotency_record WHERE principal_id=$1 AND scope=$2 AND idempotency_key=$3 AND expires_at<=now()",
      [principalId, scope, key],
    );
    const prior = await client.query<{
      request_hash: string;
      state: string;
      response_status: number | null;
      result_resource_type: string | null;
      result_resource_id: string | null;
    }>(
      "SELECT request_hash,state,response_status,result_resource_type,result_resource_id FROM idempotency_record WHERE principal_id=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE",
      [principalId, scope, key],
    );
    if (prior.rowCount) {
      const row = prior.rows[0]!;
      if (row.request_hash !== hash)
        throw new HttpError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used for a different request",
        );
      if (row.state !== "completed")
        throw new HttpError(
          "REQUEST_IN_PROGRESS",
          "Request is still in progress",
          undefined,
          true,
        );
      if (row.result_resource_type === "company") {
        const x = (
          await client.query<{
            id: string;
            name: string;
            status: string;
            created_at: Date;
          }>("SELECT id,name,status,created_at FROM company WHERE id=$1", [
            row.result_resource_id,
          ])
        ).rows[0]!;
        return {
          status: row.response_status!,
          type: "company",
          id: x.id,
          body: {
            id: x.id,
            name: x.name,
            status: x.status,
            createdAt: x.created_at.toISOString(),
          },
        };
      }
      if (row.result_resource_type === "workspace") {
        const x = (
          await client.query<{
            id: string;
            company_id: string;
            name: string;
            status: string;
            created_at: Date;
          }>(
            "SELECT id,company_id,name,status,created_at FROM workspace WHERE id=$1",
            [row.result_resource_id],
          )
        ).rows[0]!;
        return {
          status: row.response_status!,
          type: "workspace",
          id: x.id,
          body: {
            id: x.id,
            companyId: x.company_id,
            name: x.name,
            status: x.status,
            createdAt: x.created_at.toISOString(),
          },
        };
      }
      const x = (
        await client.query<{
          person_id: string;
          workspace_id: string;
          role: string;
        }>(
          "SELECT person_id,workspace_id,role FROM workspace_membership WHERE person_id=$1",
          [row.result_resource_id],
        )
      ).rows[0]!;
      return {
        status: row.response_status!,
        type: "workspace_membership",
        id: x.person_id,
        body: {
          personId: x.person_id,
          workspaceId: x.workspace_id,
          role: x.role,
        },
      };
    }
    const result = await work(client);
    await client.query(
      "INSERT INTO idempotency_record (principal_id,scope,idempotency_key,request_hash,state,response_status,result_resource_type,result_resource_id,expires_at) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,now()+interval '24 hours')",
      [principalId, scope, key, hash, result.status, result.type, result.id],
    );
    return result;
  });
}

async function enforceWriteLimit(
  options: Options,
  actor: ActorContext,
  route: Route,
  requestId: string,
): Promise<void> {
  const keyHash = createHmac("sha256", options.rateLimitSecret)
    .update(`admin-write:${actor.personId}`)
    .digest("hex");
  const result = await options.pool.query<{ request_count: number }>(
    `INSERT INTO auth_rate_limit_bucket (key_hash,window_started_at,request_count,expires_at)
     VALUES ($1,now(),1,now()+interval '60 seconds')
     ON CONFLICT (key_hash) DO UPDATE SET
       request_count=CASE WHEN auth_rate_limit_bucket.window_started_at < now()-interval '60 seconds' THEN 1 ELSE auth_rate_limit_bucket.request_count+1 END,
       window_started_at=CASE WHEN auth_rate_limit_bucket.window_started_at < now()-interval '60 seconds' THEN now() ELSE auth_rate_limit_bucket.window_started_at END,
       expires_at=now()+interval '60 seconds'
     RETURNING request_count`,
    [keyHash],
  );
  if ((result.rows[0]?.request_count ?? 0) <= 60) return;
  await options.pool.query(
    `INSERT INTO rate_limit_event (id,rule,route,request_id,person_id,subject_hash,outcome)
     VALUES ($1,'admin-write-60-per-minute',$2,$3,$4,$5,'throttled')`,
    [randomUUID(), route.path, requestId, actor.personId, keyHash],
  );
  throw new HttpError("RATE_LIMITED", "Too many requests", undefined, true);
}
