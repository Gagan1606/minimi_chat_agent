import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { Pool } from "pg";
import test, { after, before } from "node:test";
import { runMigrations } from "../src/db/migrate.js";
import { createAppServer } from "../src/app.js";
import type { OidcAdapter } from "../src/modules/auth/oidc.js";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://momos:momos@127.0.0.1:15432/momos";
const pool = new Pool({ connectionString: databaseUrl });
const sessionCookieName = "momos_session";
const activeContexts = new Set<AdminTestContext>();

interface TestUser {
  personId: string;
  cookie: string;
}

interface AdminTestContext {
  server: Server;
  baseUrl: string;
  personIds: string[];
  companyIds: string[];
  workspaceIds: string[];
  requestIds: string[];
  users: {
    platform: TestUser;
    noMfaPlatform: TestUser;
    companyAdmin: TestUser;
    workspaceAdmin: TestUser;
    member: TestUser;
    otherCompanyAdmin: TestUser;
  };
  companyId: string;
  workspaceId: string;
  otherCompanyId: string;
  closed: boolean;
  request(options: {
    path: string;
    actor?: TestUser;
    method?: string;
  }): Promise<Response>;
  close(): Promise<void>;
}

before(async () => {
  await runMigrations(pool);
});

after(async () => {
  for (const context of activeContexts) await context.close();
  await pool.end();
});

async function setup(): Promise<AdminTestContext> {
  const personIds: string[] = [];
  const companyIds: string[] = [];
  const workspaceIds: string[] = [];
  const requestIds: string[] = [];
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const workspaceId = randomUUID();
  companyIds.push(companyId, otherCompanyId);
  workspaceIds.push(workspaceId);
  await pool.query("INSERT INTO company(id,name) VALUES ($1,$2),($3,$4)", [
    companyId,
    `M6 company ${companyId}`,
    otherCompanyId,
    `M6 other company ${otherCompanyId}`,
  ]);
  await pool.query(
    "INSERT INTO workspace(id,company_id,name) VALUES ($1,$2,$3)",
    [workspaceId, companyId, `M6 workspace ${workspaceId}`],
  );

  async function addUser(
    options: {
      platform?: boolean;
      mfa?: boolean;
      companyId?: string;
      companyRole?: "member" | "company_admin";
      workspaceId?: string;
      workspaceRole?: "member" | "workspace_admin";
    } = {},
  ): Promise<TestUser> {
    const personId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    personIds.push(personId);
    await pool.query("INSERT INTO person(id,email) VALUES ($1,$2)", [
      personId,
      `${personId}@m6-test.example`,
    ]);
    if (options.platform)
      await pool.query(
        "INSERT INTO platform_admin_assignment(person_id) VALUES ($1)",
        [personId],
      );
    if (options.companyId)
      await pool.query(
        "INSERT INTO company_membership(person_id,company_id,role) VALUES ($1,$2,$3)",
        [personId, options.companyId, options.companyRole ?? "member"],
      );
    if (options.workspaceId) {
      assert.ok(options.companyId);
      await pool.query(
        "INSERT INTO workspace_membership(person_id,company_id,workspace_id,role) VALUES ($1,$2,$3,$4)",
        [
          personId,
          options.companyId,
          options.workspaceId,
          options.workspaceRole ?? "member",
        ],
      );
    }
    await pool.query(
      `INSERT INTO session(token_hash,person_id,csrf_token_hash,platform_admin,mfa_verified,
        idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,
      [
        hash(token),
        personId,
        hash(randomUUID()),
        options.platform ?? false,
        options.mfa ?? false,
      ],
    );
    return { personId, cookie: `${sessionCookieName}=${token}` };
  }

  const users = {
    platform: await addUser({ platform: true, mfa: true }),
    noMfaPlatform: await addUser({ platform: true, mfa: false }),
    companyAdmin: await addUser({ companyId, companyRole: "company_admin" }),
    workspaceAdmin: await addUser({
      companyId,
      companyRole: "member",
      workspaceId,
      workspaceRole: "workspace_admin",
    }),
    member: await addUser({
      companyId,
      companyRole: "member",
      workspaceId,
      workspaceRole: "member",
    }),
    otherCompanyAdmin: await addUser({
      companyId: otherCompanyId,
      companyRole: "company_admin",
    }),
  };

  const appBaseUrl = "http://127.0.0.1:3000";
  const oidc: OidcAdapter = {
    begin: async () => new URL("https://m6-test.example/authorize"),
    complete: async () => ({
      issuer: "https://m6-test.example/issuer",
      subject: "unused",
      amr: ["pwd"],
    }),
  };
  const server = createAppServer({
    pool,
    oidc,
    config: {
      appBaseUrl,
      oidcRedirectUri: `${appBaseUrl}/auth/oidc/callback`,
      oidcScopes: ["openid", "profile", "email"],
      oidcClientSecret: "m6-app-integration-test-secret",
      sessionCookieName,
      oidcTransactionCookieName: "momos_oidc_transaction",
      sessionCookieSecure: false,
      sessionIdleTimeoutSeconds: 3600,
      sessionAbsoluteTimeoutSeconds: 86400,
      platformAdminBootstrap: {
        issuer: "https://m6-test.example/issuer",
        subject: "unused-platform-admin",
      },
      oidcStartMax: 10,
      oidcStartWindowSeconds: 900,
    },
    adminStatus: {
      model: "configured",
      webSearch: "configured",
      embeddings: "not_configured",
      vectorStore: "not_configured",
      backup: "not_reported",
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const context: AdminTestContext = {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    personIds,
    companyIds,
    workspaceIds,
    requestIds,
    users,
    companyId,
    workspaceId,
    otherCompanyId,
    closed: false,
    request: async ({ path, actor, method = "GET" }) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        ...(actor ? { headers: { cookie: actor.cookie } } : {}),
      }),
    close: async () => {
      if (context.closed) return;
      context.closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await pool.query(
        "DELETE FROM rate_limit_event WHERE request_id = ANY($1::uuid[])",
        [requestIds],
      );
      await pool.query(
        "DELETE FROM admin_audit_event WHERE request_id = ANY($1::uuid[])",
        [requestIds],
      );
      await pool.query(
        "DELETE FROM session WHERE person_id = ANY($1::uuid[])",
        [personIds],
      );
      await pool.query(
        `DELETE FROM citation WHERE assistant_message_id IN (
           SELECT m.id FROM message m JOIN conversation c ON c.id=m.conversation_id
           WHERE c.owner_person_id=ANY($1::uuid[])
         )`,
        [personIds],
      );
      await pool.query(
        "DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_person_id=ANY($1::uuid[]))",
        [personIds],
      );
      await pool.query(
        "DELETE FROM conversation WHERE owner_person_id=ANY($1::uuid[])",
        [personIds],
      );
      await pool.query(
        "DELETE FROM platform_admin_assignment WHERE person_id = ANY($1::uuid[])",
        [personIds],
      );
      await pool.query(
        "DELETE FROM workspace_membership WHERE person_id = ANY($1::uuid[])",
        [personIds],
      );
      await pool.query(
        "DELETE FROM company_membership WHERE person_id = ANY($1::uuid[])",
        [personIds],
      );
      await pool.query("DELETE FROM workspace WHERE id = ANY($1::uuid[])", [
        workspaceIds,
      ]);
      await pool.query("DELETE FROM company WHERE id = ANY($1::uuid[])", [
        companyIds,
      ]);
      await pool.query("DELETE FROM person WHERE id = ANY($1::uuid[])", [
        personIds,
      ]);
      activeContexts.delete(context);
    },
  };
  activeContexts.add(context);
  return context;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("admin overview returns platform and scoped customer aggregates with no cross-tenant leakage", async (t) => {
  const context = await setup();
  t.after(context.close);
  await pool.query(
    `INSERT INTO conversation(id,scope,owner_person_id,workspace_id,title)
     VALUES ($1,'workspace',$2,$3,'internal fixture title'),
            ($4,'personal',$5,NULL,'other tenant fixture title')`,
    [
      randomUUID(),
      context.users.member.personId,
      context.workspaceId,
      randomUUID(),
      context.users.otherCompanyAdmin.personId,
    ],
  );

  const platform = await context.request({
    path: "/api/v1/admin/overview",
    actor: context.users.platform,
  });
  assert.equal(platform.status, 200);
  const platformBody = await platform.json();
  assert.equal(platformBody.scope, "platform");
  assert.equal(platformBody.providers.model, "configured");
  assert.equal(platformBody.backup.status, "not_reported");
  assert.equal(JSON.stringify(platformBody).includes("fixture title"), false);

  const company = await context.request({
    path: "/api/v1/admin/overview",
    actor: context.users.companyAdmin,
  });
  assert.equal(company.status, 200);
  const companyBody = await company.json();
  assert.equal(companyBody.scope, "company");
  assert.equal(companyBody.company.id, context.companyId);
  assert.equal(
    JSON.stringify(companyBody).includes(context.otherCompanyId),
    false,
  );

  const workspace = await context.request({
    path: "/api/v1/admin/overview",
    actor: context.users.workspaceAdmin,
  });
  assert.equal(workspace.status, 200);
  const workspaceBody = await workspace.json();
  assert.equal(workspaceBody.scope, "workspace");
  assert.equal(workspaceBody.workspace.id, context.workspaceId);

  assert.equal(
    (await context.request({ path: "/api/v1/admin/overview" })).status,
    401,
  );
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/overview",
        actor: context.users.member,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/overview?companyId=" + context.otherCompanyId,
        actor: context.users.companyAdmin,
      })
    ).status,
    422,
  );
});

test("detailed rate-limit events are Platform Admin only, paginated, filtered, and content-free", async (t) => {
  const context = await setup();
  t.after(context.close);
  const eventIds = [randomUUID(), randomUUID(), randomUUID()];
  const eventRequestIds = [randomUUID(), randomUUID(), randomUUID()];
  const chatRule = `m6.${randomUUID()}`;
  context.requestIds.push(...eventRequestIds);
  await pool.query(
    `INSERT INTO rate_limit_event(id,rule,route,request_id,person_id,company_id,workspace_id,subject_hash)
     VALUES ($1,$19,'/api/v1/chat',$4,$7,$8,$9,$10),
            ($2,'personal.history.read','/api/v1/conversations',$5,$11,$12,$13,$14),
            ($3,$19,'/api/v1/chat',$6,$15,$16,$17,$18)`,
    [
      ...eventIds,
      ...eventRequestIds,
      context.users.member.personId,
      context.companyId,
      context.workspaceId,
      hash("rate-event-1"),
      context.users.member.personId,
      context.companyId,
      context.workspaceId,
      hash("rate-event-2"),
      context.users.otherCompanyAdmin.personId,
      context.otherCompanyId,
      null,
      hash("rate-event-3"),
      chatRule,
    ],
  );

  const platform = await context.request({
    path: `/api/v1/admin/rate-limit-events?limit=1&rule=${encodeURIComponent(chatRule)}`,
    actor: context.users.platform,
  });
  assert.equal(platform.status, 200);
  const body = await platform.json();
  assert.equal(body.items.length, 1);
  assert.equal(
    body.items.every((item: { rule: string }) => item.rule === chatRule),
    true,
  );
  assert.equal(typeof body.nextCursor, "string");
  assert.equal(JSON.stringify(body).includes("prompt"), false);

  const next = await context.request({
    path: `/api/v1/admin/rate-limit-events?limit=1&rule=${encodeURIComponent(chatRule)}&cursor=${encodeURIComponent(body.nextCursor)}`,
    actor: context.users.platform,
  });
  assert.equal(next.status, 200);
  const nextBody = await next.json();
  assert.equal(nextBody.items.length, 1);
  assert.equal(nextBody.nextCursor, null);
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/rate-limit-events",
        actor: context.users.companyAdmin,
      })
    ).status,
    403,
  );
  assert.equal(
    (await context.request({ path: "/api/v1/admin/rate-limit-events" })).status,
    401,
  );
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/rate-limit-events?limit=51",
        actor: context.users.platform,
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/rate-limit-events",
        actor: context.users.noMfaPlatform,
      })
    ).status,
    403,
  );
});

test("security audit events are Platform Admin only and contain metadata without content", async (t) => {
  const context = await setup();
  t.after(context.close);
  const eventId = randomUUID();
  const requestId = randomUUID();
  context.requestIds.push(requestId);
  await pool.query(
    `INSERT INTO admin_audit_event(id,actor_person_id,action,target_type,target_id,
       company_id,workspace_id,request_id,outcome)
     VALUES ($1,$2,'workspace.member.added','workspace_membership',$3,$4,$5,$6,'succeeded')`,
    [
      eventId,
      context.users.companyAdmin.personId,
      context.users.member.personId,
      context.companyId,
      context.workspaceId,
      requestId,
    ],
  );

  const platform = await context.request({
    path: "/api/v1/admin/security-events?limit=10",
    actor: context.users.platform,
  });
  assert.equal(platform.status, 200);
  const body = await platform.json();
  const event = body.items.find((item: { id: string }) => item.id === eventId);
  assert.equal(event.action, "workspace.member.added");
  assert.equal("content" in event, false);
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/security-events?limit=1&rule=anything",
        actor: context.users.platform,
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await context.request({
        path: "/api/v1/admin/security-events",
        actor: context.users.otherCompanyAdmin,
      })
    ).status,
    403,
  );
  assert.equal(
    (await context.request({ path: "/api/v1/admin/security-events" })).status,
    401,
  );
});

test("admin views are served by the app with same-origin scripts and security headers", async () => {
  const context = await setup();
  try {
    for (const view of ["platform", "company", "workspace"]) {
      const page = await fetch(`${context.baseUrl}/admin/${view}`);
      assert.equal(page.status, 200);
      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /script-src 'self'/,
      );
      assert.match(await page.text(), /src="\.\/admin\.js"/);
    }
    const script = await fetch(`${context.baseUrl}/admin/admin.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /rate-limit-events/);
  } finally {
    await context.close();
  }
});
