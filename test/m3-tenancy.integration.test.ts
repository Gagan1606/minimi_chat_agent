import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { createTenancyHandler } from "../src/modules/tenancy/routes.js";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a real local PostgreSQL database before testing.",
  );
}

const pool = createPool(databaseUrl);
const rateLimitSecret = "m3-tenancy-integration-test-secret-32-bytes-min";
const sessionCookieName = "momos_session";

interface TestContext {
  personIds: string[];
  companyIds: string[];
  workspaceIds: string[];
  requestIds: string[];
  rateLimitKeys: string[];
  server?: Server;
  baseUrl?: string;
}

interface UserSession {
  personId: string;
  cookie: string;
  csrfToken: string;
  companyId?: string;
  workspaceId?: string;
}

interface TenantFixture {
  companyId: string;
  workspaceIds: string[];
  companyAdmin: UserSession;
  workspaceAdmins: UserSession[];
  members: UserSession[];
}

before(async () => {
  await runMigrations(pool);
});

after(async () => {
  await pool.end();
});

function newContext(): TestContext {
  return {
    personIds: [],
    companyIds: [],
    workspaceIds: [],
    requestIds: [],
    rateLimitKeys: [],
  };
}

async function cleanup(context: TestContext): Promise<void> {
  await pool.query(
    `DELETE FROM admin_audit_event
     WHERE request_id = ANY($1::uuid[])
        OR actor_person_id = ANY($2::uuid[])
        OR company_id = ANY($3::uuid[])
        OR workspace_id = ANY($4::uuid[])`,
    [
      context.requestIds,
      context.personIds,
      context.companyIds,
      context.workspaceIds,
    ],
  );
  if (context.personIds.length) {
    await pool.query("DELETE FROM session WHERE person_id = ANY($1::uuid[])", [
      context.personIds,
    ]);
    await pool.query(
      "DELETE FROM platform_admin_assignment WHERE person_id = ANY($1::uuid[])",
      [context.personIds],
    );
    await pool.query(
      "DELETE FROM company_membership WHERE person_id = ANY($1::uuid[])",
      [context.personIds],
    );
  }
  if (context.workspaceIds.length) {
    await pool.query("DELETE FROM workspace WHERE id = ANY($1::uuid[])", [
      context.workspaceIds,
    ]);
  }
  if (context.companyIds.length) {
    await pool.query("DELETE FROM company WHERE id = ANY($1::uuid[])", [
      context.companyIds,
    ]);
  }
  if (context.personIds.length) {
    await pool.query("DELETE FROM person WHERE id = ANY($1::uuid[])", [
      context.personIds,
    ]);
  }
  if (context.rateLimitKeys.length) {
    await pool.query(
      "DELETE FROM auth_rate_limit_bucket WHERE key_hash = ANY($1::char(64)[])",
      [context.rateLimitKeys],
    );
  }
  if (context.server) {
    context.server.close();
    await once(context.server, "close");
  }
}

async function makeServer(context: TestContext): Promise<string> {
  context.server = createServer((request, response) => {
    const requestId = randomUUID();
    context.requestIds.push(requestId);
    response.setHeader("x-request-id", requestId);
    void createTenancyHandler({
      pool,
      sessionCookieName,
      rateLimitSecret,
    })(request, response, requestId).catch(() => {
      if (!response.headersSent) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "Service unavailable",
              requestId,
              retryable: true,
            },
          }),
        );
      } else {
        response.destroy();
      }
    });
  });
  context.server.listen(0, "127.0.0.1");
  await once(context.server, "listening");
  const address = context.server.address();
  assert.ok(address && typeof address !== "string");
  context.baseUrl = `http://127.0.0.1:${address.port}`;
  return context.baseUrl;
}

async function addPerson(
  context: TestContext,
  options: {
    companyId?: string;
    companyRole?: "member" | "company_admin";
    workspaceId?: string;
    workspaceRole?: "member" | "workspace_admin";
    platformAdmin?: boolean;
    mfaVerified?: boolean;
  } = {},
): Promise<UserSession> {
  const personId = randomUUID();
  context.personIds.push(personId);
  await pool.query("INSERT INTO person (id, email) VALUES ($1, $2)", [
    personId,
    `${personId}@example.test`,
  ]);
  if (options.companyId) {
    await pool.query(
      `INSERT INTO company_membership (person_id, company_id, role)
       VALUES ($1, $2, $3)`,
      [personId, options.companyId, options.companyRole ?? "member"],
    );
  }
  if (options.workspaceId) {
    assert.ok(options.companyId);
    await pool.query(
      `INSERT INTO workspace_membership (person_id, company_id, workspace_id, role)
       VALUES ($1, $2, $3, $4)`,
      [
        personId,
        options.companyId,
        options.workspaceId,
        options.workspaceRole ?? "member",
      ],
    );
  }
  const token = randomUUID() + randomUUID();
  const csrfToken = randomUUID() + randomUUID();
  await pool.query(
    `INSERT INTO session
      (token_hash, person_id, csrf_token_hash, platform_admin, mfa_verified,
       idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour', now() + interval '1 day')`,
    [
      sha256(token),
      personId,
      sha256(csrfToken),
      options.platformAdmin ?? false,
      options.mfaVerified ?? false,
    ],
  );
  if (options.platformAdmin) {
    await pool.query(
      "INSERT INTO platform_admin_assignment (person_id) VALUES ($1)",
      [personId],
    );
  }
  context.rateLimitKeys.push(
    createHmac("sha256", rateLimitSecret)
      .update(`admin-write:${personId}`)
      .digest("hex"),
  );
  return {
    personId,
    cookie: `${sessionCookieName}=${token}`,
    csrfToken,
    ...(options.companyId ? { companyId: options.companyId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  };
}

async function makeTenant(
  context: TestContext,
  workspaceCount = 1,
): Promise<TenantFixture> {
  const companyId = randomUUID();
  context.companyIds.push(companyId);
  await pool.query("INSERT INTO company (id, name) VALUES ($1, $2)", [
    companyId,
    `Company ${companyId}`,
  ]);
  const companyAdmin = await addPerson(context, {
    companyId,
    companyRole: "company_admin",
  });
  const workspaceIds: string[] = [];
  const workspaceAdmins: UserSession[] = [];
  const members: UserSession[] = [];
  for (let index = 0; index < workspaceCount; index += 1) {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    context.workspaceIds.push(workspaceId);
    await pool.query(
      "INSERT INTO workspace (id, company_id, name) VALUES ($1, $2, $3)",
      [workspaceId, companyId, `Team ${index + 1} ${workspaceId}`],
    );
    workspaceAdmins.push(
      await addPerson(context, {
        companyId,
        workspaceId,
        workspaceRole: "workspace_admin",
      }),
    );
    members.push(
      await addPerson(context, {
        companyId,
        workspaceId,
        workspaceRole: "member",
      }),
    );
  }
  return { companyId, workspaceIds, companyAdmin, workspaceAdmins, members };
}

async function request(
  context: TestContext,
  options: {
    method: string;
    path: string;
    actor?: UserSession;
    body?: unknown;
    idempotencyKey?: string;
    csrf?: boolean;
  },
): Promise<Response> {
  const baseUrl = context.baseUrl ?? (await makeServer(context));
  const headers = new Headers();
  if (options.actor) {
    headers.set("cookie", options.actor.cookie);
    if (options.csrf !== false) {
      headers.set("x-csrf-token", options.actor.csrfToken);
    }
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  return fetch(`${baseUrl}${options.path}`, {
    method: options.method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyKey(): string {
  return randomUUID();
}

test("Platform Admin creates a company and Company Admin; creation is idempotent", async () => {
  const context = newContext();
  try {
    const admin = await addPerson(context, {
      platformAdmin: true,
      mfaVerified: true,
    });
    const nextCompanyAdmin = await addPerson(context);
    await makeServer(context);
    const body = {
      name: "Acme test",
      companyAdminPersonId: nextCompanyAdmin.personId,
    };
    const key = idempotencyKey();
    const response = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: admin,
      body,
      idempotencyKey: key,
    });
    assert.equal(response.status, 201);
    const created = await readJson<{
      id: string;
      name: string;
      status: string;
      createdAt: string;
    }>(response);
    context.companyIds.push(created.id);
    assert.equal(created.name, "Acme test");
    assert.equal(created.status, "active");
    const membership = await pool.query<{ role: string; company_id: string }>(
      "SELECT role, company_id FROM company_membership WHERE person_id = $1",
      [nextCompanyAdmin.personId],
    );
    assert.deepEqual(membership.rows[0], {
      role: "company_admin",
      company_id: created.id,
    });
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId);
    context.requestIds.push(requestId);
    const audit = await pool.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM admin_audit_event WHERE request_id = $1",
      [requestId],
    );
    assert.deepEqual(audit.rows, [
      { action: "company.create", target_id: created.id },
    ]);

    const replay = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: admin,
      body,
      idempotencyKey: key,
    });
    assert.equal(replay.status, 201);
    assert.equal((await readJson<{ id: string }>(replay)).id, created.id);
    const conflict = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: admin,
      body: { ...body, name: "Different name" },
      idempotencyKey: key,
    });
    assert.equal(conflict.status, 409);
    const companyCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM company WHERE id = $1",
      [created.id],
    );
    assert.equal(companyCount.rows[0]?.count, "1");

    const invalid = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: admin,
      body: { name: "  ", companyAdminPersonId: randomUUID() },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(unauthenticated.status, 401);
    const company = await makeTenant(context);
    const wrongRole = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: company.companyAdmin,
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(wrongRole.status, 403);
    const noMfa = await addPerson(context, {
      platformAdmin: true,
      mfaVerified: false,
    });
    const noMfaResponse = await request(context, {
      method: "POST",
      path: "/api/v1/platform/companies",
      actor: noMfa,
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(noMfaResponse.status, 403);
  } finally {
    await cleanup(context);
  }
});

test("Company Admin creates workspaces only in their company", async () => {
  const context = newContext();
  try {
    const tenant = await makeTenant(context);
    const otherTenant = await makeTenant(context);
    await makeServer(context);
    const key = idempotencyKey();
    const response = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/workspaces`,
      actor: tenant.companyAdmin,
      body: { name: "New team" },
      idempotencyKey: key,
    });
    assert.equal(response.status, 201);
    const created = await readJson<{
      id: string;
      companyId: string;
      name: string;
      status: string;
    }>(response);
    context.workspaceIds.push(created.id);
    assert.equal(created.companyId, tenant.companyId);
    assert.equal(created.name, "New team");
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace WHERE id = $1 AND company_id = $2",
      [created.id, tenant.companyId],
    );
    assert.equal(rows.rows[0]?.count, "1");
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId);
    context.requestIds.push(requestId);
    const audit = await pool.query<{ action: string; company_id: string }>(
      "SELECT action, company_id FROM admin_audit_event WHERE request_id = $1",
      [requestId],
    );
    assert.deepEqual(audit.rows[0], {
      action: "workspace.create",
      company_id: tenant.companyId,
    });

    const invalid = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/workspaces`,
      actor: tenant.companyAdmin,
      body: { name: "" },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/workspaces`,
      body: { name: "No auth" },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/workspaces`,
      actor: tenant.workspaceAdmins[0],
      body: { name: "Forbidden" },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(wrongRole.status, 403);
    const crossTenant = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/workspaces`,
      actor: otherTenant.companyAdmin,
      body: { name: "Cross tenant" },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(crossTenant.status, 404);
    const noSideEffect = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace WHERE company_id = $1 AND name = 'Cross tenant'",
      [tenant.companyId],
    );
    assert.equal(noSideEffect.rows[0]?.count, "0");
  } finally {
    await cleanup(context);
  }
});

test("Company Admin adds and removes company members with workspace scope", async () => {
  const context = newContext();
  try {
    const tenant = await makeTenant(context);
    const otherTenant = await makeTenant(context);
    const candidate = await addPerson(context);
    await makeServer(context);
    const addKey = idempotencyKey();
    const body = {
      personId: candidate.personId,
      workspaceId: tenant.workspaceIds[0]!,
    };
    const added = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/members`,
      actor: tenant.companyAdmin,
      body,
      idempotencyKey: addKey,
    });
    assert.equal(added.status, 201);
    assert.deepEqual(await readJson(added), {
      personId: candidate.personId,
      workspaceId: tenant.workspaceIds[0]!,
      role: "member",
    });
    const membership = await pool.query<{
      company_count: string;
      workspace_count: string;
    }>(
      `
      SELECT
        (SELECT count(*) FROM company_membership WHERE person_id = $1 AND company_id = $2)::text AS company_count,
        (SELECT count(*) FROM workspace_membership WHERE person_id = $1 AND workspace_id = $3)::text AS workspace_count
    `,
      [candidate.personId, tenant.companyId, tenant.workspaceIds[0]!],
    );
    assert.deepEqual(membership.rows[0], {
      company_count: "1",
      workspace_count: "1",
    });
    const requestId = added.headers.get("x-request-id");
    assert.ok(requestId);
    context.requestIds.push(requestId);
    const audit = await pool.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM admin_audit_event WHERE request_id = $1",
      [requestId],
    );
    assert.deepEqual(audit.rows[0], {
      action: "company.member.add",
      target_id: candidate.personId,
    });

    const invalid = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/members`,
      actor: tenant.companyAdmin,
      body: { personId: "invalid", workspaceId: tenant.workspaceIds[0]! },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/members`,
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/members`,
      actor: tenant.workspaceAdmins[0],
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(wrongRole.status, 403);
    const crossTenant = await request(context, {
      method: "POST",
      path: `/api/v1/companies/${tenant.companyId}/members`,
      actor: otherTenant.companyAdmin,
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(crossTenant.status, 404);

    const removed = await request(context, {
      method: "DELETE",
      path: `/api/v1/companies/${tenant.companyId}/members/${candidate.personId}`,
      actor: tenant.companyAdmin,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await readJson(removed), {
      personId: candidate.personId,
      removed: true,
    });
    const afterRemoval = await pool.query<{
      company_count: string;
      workspace_count: string;
    }>(
      `
      SELECT
        (SELECT count(*) FROM company_membership WHERE person_id = $1)::text AS company_count,
        (SELECT count(*) FROM workspace_membership WHERE person_id = $1)::text AS workspace_count
    `,
      [candidate.personId],
    );
    assert.deepEqual(afterRemoval.rows[0], {
      company_count: "0",
      workspace_count: "0",
    });

    const invalidDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/companies/${tenant.companyId}/members/not-a-uuid`,
      actor: tenant.companyAdmin,
    });
    assert.equal(invalidDelete.status, 422);
    const unauthenticatedDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/companies/${tenant.companyId}/members/${tenant.members[0]!.personId}`,
    });
    assert.equal(unauthenticatedDelete.status, 401);
    const wrongRoleDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/companies/${tenant.companyId}/members/${tenant.members[0]!.personId}`,
      actor: tenant.workspaceAdmins[0],
    });
    assert.equal(wrongRoleDelete.status, 403);
    const crossTenantDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/companies/${tenant.companyId}/members/${tenant.members[0]!.personId}`,
      actor: otherTenant.companyAdmin,
    });
    assert.equal(crossTenantDelete.status, 404);
  } finally {
    await cleanup(context);
  }
});

test("Workspace Admin adds/removes ordinary members only in their workspace", async () => {
  const context = newContext();
  try {
    const tenant = await makeTenant(context, 2);
    const candidate = await addPerson(context, { companyId: tenant.companyId });
    await makeServer(context);
    const body = { personId: candidate.personId };
    const key = idempotencyKey();
    const added = await request(context, {
      method: "POST",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members`,
      actor: tenant.workspaceAdmins[0],
      body,
      idempotencyKey: key,
    });
    assert.equal(added.status, 201);
    assert.deepEqual(await readJson(added), {
      personId: candidate.personId,
      workspaceId: tenant.workspaceIds[0]!,
      role: "member",
    });
    const sideEffect = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_membership WHERE person_id = $1 AND workspace_id = $2 AND role = 'member'",
      [candidate.personId, tenant.workspaceIds[0]!],
    );
    assert.equal(sideEffect.rows[0]?.count, "1");

    const invalid = await request(context, {
      method: "POST",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members`,
      actor: tenant.workspaceAdmins[0],
      body: { personId: "invalid" },
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "POST",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members`,
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await request(context, {
      method: "POST",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members`,
      actor: tenant.members[0],
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(wrongRole.status, 403);
    const crossWorkspace = await request(context, {
      method: "POST",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members`,
      actor: tenant.workspaceAdmins[1],
      body,
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(crossWorkspace.status, 404);

    const removed = await request(context, {
      method: "DELETE",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members/${candidate.personId}`,
      actor: tenant.workspaceAdmins[0],
    });
    assert.equal(removed.status, 200);
    const afterRemoval = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_membership WHERE person_id = $1 AND workspace_id = $2",
      [candidate.personId, tenant.workspaceIds[0]!],
    );
    assert.equal(afterRemoval.rows[0]?.count, "0");
    const invalidDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members/not-a-uuid`,
      actor: tenant.workspaceAdmins[0],
    });
    assert.equal(invalidDelete.status, 422);
    const unauthenticatedDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members/${tenant.members[0]!.personId}`,
    });
    assert.equal(unauthenticatedDelete.status, 401);
    const wrongRoleDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members/${tenant.members[0]!.personId}`,
      actor: tenant.members[0],
    });
    assert.equal(wrongRoleDelete.status, 403);
    const crossWorkspaceDelete = await request(context, {
      method: "DELETE",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/members/${tenant.members[0]!.personId}`,
      actor: tenant.workspaceAdmins[1],
    });
    assert.equal(crossWorkspaceDelete.status, 404);
  } finally {
    await cleanup(context);
  }
});

test("Platform Admin replaces Company Admin; non-platform and cross-company requests are denied", async () => {
  const context = newContext();
  try {
    const tenant = await makeTenant(context);
    const otherTenant = await makeTenant(context);
    const platformAdmin = await addPerson(context, {
      platformAdmin: true,
      mfaVerified: true,
    });
    const newAdmin = await addPerson(context, { companyId: tenant.companyId });
    await makeServer(context);
    const path = `/api/v1/companies/${tenant.companyId}/company-admin`;
    const response = await request(context, {
      method: "PUT",
      path,
      actor: platformAdmin,
      body: { personId: newAdmin.personId },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      personId: newAdmin.personId,
      companyId: tenant.companyId,
      role: "company_admin",
    });
    const admins = await pool.query<{ person_id: string; role: string }>(
      "SELECT person_id, role FROM company_membership WHERE company_id = $1 AND role = 'company_admin'",
      [tenant.companyId],
    );
    assert.deepEqual(admins.rows, [
      { person_id: newAdmin.personId, role: "company_admin" },
    ]);
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId);
    context.requestIds.push(requestId);
    const audit = await pool.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM admin_audit_event WHERE request_id = $1",
      [requestId],
    );
    assert.deepEqual(audit.rows[0], {
      action: "company.admin.assign",
      target_id: newAdmin.personId,
    });
    const invalid = await request(context, {
      method: "PUT",
      path,
      actor: platformAdmin,
      body: { personId: "invalid" },
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "PUT",
      path,
      body: { personId: newAdmin.personId },
    });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await request(context, {
      method: "PUT",
      path,
      actor: tenant.companyAdmin,
      body: { personId: newAdmin.personId },
    });
    assert.equal(wrongRole.status, 403);
    const crossTenant = await request(context, {
      method: "PUT",
      path: `/api/v1/companies/${otherTenant.companyId}/company-admin`,
      actor: tenant.companyAdmin,
      body: { personId: otherTenant.companyAdmin.personId },
    });
    assert.equal(crossTenant.status, 404);
    const noMfa = await addPerson(context, {
      platformAdmin: true,
      mfaVerified: false,
    });
    const noMfaResponse = await request(context, {
      method: "PUT",
      path,
      actor: noMfa,
      body: { personId: newAdmin.personId },
    });
    assert.equal(noMfaResponse.status, 403);
  } finally {
    await cleanup(context);
  }
});

test("Company Admin replaces Workspace Admin only in assigned company", async () => {
  const context = newContext();
  try {
    const tenant = await makeTenant(context, 2);
    const otherTenant = await makeTenant(context);
    const newAdmin = await addPerson(context, {
      companyId: tenant.companyId,
      workspaceId: tenant.workspaceIds[0]!,
      workspaceRole: "member",
    });
    await makeServer(context);
    const path = `/api/v1/workspaces/${tenant.workspaceIds[0]!}/workspace-admin`;
    const response = await request(context, {
      method: "PUT",
      path,
      actor: tenant.companyAdmin,
      body: { personId: newAdmin.personId },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      personId: newAdmin.personId,
      workspaceId: tenant.workspaceIds[0]!,
      role: "workspace_admin",
    });
    const admins = await pool.query<{ person_id: string; role: string }>(
      "SELECT person_id, role FROM workspace_membership WHERE workspace_id = $1 AND role = 'workspace_admin'",
      [tenant.workspaceIds[0]!],
    );
    assert.deepEqual(admins.rows, [
      { person_id: newAdmin.personId, role: "workspace_admin" },
    ]);
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId);
    context.requestIds.push(requestId);
    const audit = await pool.query<{ action: string; workspace_id: string }>(
      "SELECT action, workspace_id FROM admin_audit_event WHERE request_id = $1",
      [requestId],
    );
    assert.deepEqual(audit.rows[0], {
      action: "workspace.admin.assign",
      workspace_id: tenant.workspaceIds[0]!,
    });
    const invalid = await request(context, {
      method: "PUT",
      path,
      actor: tenant.companyAdmin,
      body: { personId: "invalid" },
    });
    assert.equal(invalid.status, 422);
    const unauthenticated = await request(context, {
      method: "PUT",
      path,
      body: { personId: newAdmin.personId },
    });
    assert.equal(unauthenticated.status, 401);
    const wrongRole = await request(context, {
      method: "PUT",
      path,
      actor: tenant.workspaceAdmins[0],
      body: { personId: newAdmin.personId },
    });
    assert.equal(wrongRole.status, 403);
    const crossTenant = await request(context, {
      method: "PUT",
      path: `/api/v1/workspaces/${tenant.workspaceIds[0]!}/workspace-admin`,
      actor: otherTenant.companyAdmin,
      body: { personId: otherTenant.companyAdmin.personId },
    });
    assert.equal(crossTenant.status, 404);
  } finally {
    await cleanup(context);
  }
});
