# Momos System Design

This design follows [`SPEC.md`](SPEC.md): individual chat, company workspaces, private personal history, same-workspace context recall, vendor-independent adapters, and the stated service/security targets. It favors a small system that can be measured before adding infrastructure.

## System architecture

Use a **TypeScript modular monolith**: one browser application and one Node.js service, with clear internal modules for HTTP/API, identity and authorization, chat orchestration, history, administration, and external adapters.

Browser UI → HTTPS Node.js app/API → PostgreSQL

The Node.js app also calls replaceable OIDC, model, web-search, embedding, and vector-store adapters. Model and search providers are distinct interfaces even if one vendor supplies both. The agent exposes web search as its only tool; conversation retrieval is an internal history service. Provider-specific request/response formats are normalized at the adapter boundary.

For each chat turn, the service authenticates the user, determines personal or workspace scope from the session, validates input, retrieves only permitted context, calls the search/model adapters, then persists the answer and citations. Database transactions end before external calls begin. Persistence uses short transactions, and a retry with the same idempotency key cannot create another turn.

Do not add microservices, a general plugin framework, or a distributed cache. Use PostgreSQL full-text search/date filters together with a vendor-independent vector database for semantic retrieval: lexical search finds exact names and phrases, while vector similarity finds related meaning when wording differs. PostgreSQL remains the source of truth; add only the vector service needed for this retrieval requirement.

## Data model and indexes

Keep PostgreSQL as the source of truth. Use opaque, non-sequential public identifiers; **UUIDv7 is the recommended ID format** because it sorts roughly by creation time while avoiding sequential public IDs.

- **Person:** internal ID and OIDC issuer/subject pair. Store only profile fields needed for account operations.
- **Company and company membership:** a company contains workspaces; one person belongs to one company at a time. The membership identifies the single Company Admin.
- **Workspace and workspace membership:** each workspace belongs to one company; one person belongs to one workspace at a time. The membership identifies the single Workspace Admin.
- **Conversation:** either personal (owner person, no workspace) or workspace-scoped (originating person and workspace). Personal conversations are readable only by the owner. Workspace conversations are directly readable by their originator; other teammates’ messages may be retrieved only for same-workspace model context. Originator identity remains protected metadata for authorization and is never included in context or exposed in an answer.
- **Message:** conversation, author/role, content, creation time, and a generated PostgreSQL full-text search vector.
- **Semantic index record:** message ID, embedding, timestamp, and scope/status metadata in the vector database; message content remains canonical in PostgreSQL. Embeddings and metadata are sensitive derived data and follow the source message's access and deletion lifecycle. Scope/status/IDs are retrieval and authorization metadata only, never model context.
- **Citation:** assistant message, source URL/title, access/check time, and optional publication date.
- **Idempotency record:** authenticated principal, scope, key, request hash, completion state, and response/message reference.
- **Audit event and rate-limit event:** administrative or throttling metadata; neither stores prompts, answers, credentials, or source content.

Expected indexes:

- Unique `(issuer, subject)` on Person for stable OIDC identity lookup.
- Unique `person_id` on company membership and on workspace membership to enforce the one-company/one-workspace rule. Partial unique indexes on `company_id` for `Company Admin` and `workspace_id` for `Workspace Admin` enforce one admin of each kind.
- `(company_id, id)` on Workspace for tenant-scoped listing.
- Partial `(owner_person_id, updated_at DESC, id DESC)` for personal conversation listing; `(workspace_id, updated_at DESC, id DESC)` for workspace conversation listing/context scope.
- `(conversation_id, created_at, id)` on Message for transcript reads; GIN on the generated search vector for exact-term recall. The vector database needs an approximate-nearest-neighbor index over embeddings and metadata filters for scope, timestamp, and message status. Apply person/workspace predicates in both retrieval paths, then re-check candidate message IDs and authorization against PostgreSQL. Before sending context to the model, strip author/originator identity, role, conversation/message IDs, and scope metadata; each context item contains only message content and timestamp.
- `(message_id, id)` on Citation for answer rendering.
- Unique `(principal_id, scope, idempotency_key)` plus an `expires_at` index for safe cleanup of idempotency records.
- `(company_id, occurred_at DESC)` and `(workspace_id, occurred_at DESC)` on audit/rate-limit events, plus `(occurred_at DESC)` for platform-wide review.

The model-context query is deliberately separate from transcript APIs: it combines full-text/date results with vector-similarity candidates, filters to the active user’s personal scope or the active workspace, and returns a small set of relevant snippets. For workspace context, relevance and model input use only message content and timestamp; author/originator identity is not used for ranking or included in snippets, prompts, tool inputs, citations, logs, or generated output. Requester identity and workspace/scope metadata may be used server-side only to authenticate, authorize, and filter eligible records. PostgreSQL authorization checks are authoritative even when the vector database returns a candidate. No conversation is directly listed to a teammate merely because it can inform an answer.

## API design

- Prefix application routes with `/api/v1`. Make compatible additions within v1; introduce a new version only for a breaking contract change. Keep health endpoints separate from business APIs.
- Use JSON request/response bodies and complete responses rather than streaming. The spec sets a 10,000-character message limit and a 50-conversation page size.
- Use opaque cursor pagination ordered by `(created_at, id)`, with the current person/workspace scope bound into the cursor and query. Avoid offset pagination for growing histories.
- Return one error envelope for every route: a stable machine code, safe message, request ID, retryable flag, and optional field errors. Use HTTP status consistently: 400/422 invalid input, 401 unauthenticated, 403 forbidden role, 404 missing or out-of-scope object, 409 idempotency conflict, 429 throttled, 502 invalid upstream response, 503 dependency unavailable, and 504 deadline exceeded. Never return stack traces or provider secrets.
- Require an `Idempotency-Key` for `POST /api/v1/chat` and resource-creating writes. Store the key with the principal, scope, and request hash. Same key and same request returns the original result; same key with a different body returns 409; a duplicate while work is active returns a retryable in-progress response. Make PUT/PATCH operations state-setting and DELETE operations safe to repeat.
- Validate request schemas at the boundary. Do not accept `company_id`, role, or workspace scope as authority from the client; derive authorization scope from the authenticated session and check requested IDs against it.

## Authentication and authorization

Use vendor-independent OIDC authorization-code flow with PKCE, state, and nonce checks. Map an identity by `(issuer, subject)`. Issue a rotated, opaque session cookie with `Secure`, `HttpOnly`, and `SameSite=Lax` or stricter attributes; use CSRF protection for cookie-authenticated writes. Require MFA for Platform Admins and provision that role privately, not through public sign-up.

Authorization roles are `Member`, `Workspace Admin`, `Company Admin`, and `Platform Admin`. Each person is in one company and one workspace at a time; each company and workspace has one designated admin. Company Admin assigns/replaces the Workspace Admin; Platform Admin can replace the Company Admin. A Company Admin does not become a member of every workspace automatically.

For each request, middleware builds a trusted actor context. Service/repository methods require that context and add owner, company, or workspace predicates to every read and mutation. Reject cross-company and cross-workspace access before fetching content. Return 404 for an object outside the caller’s scope to avoid confirming its existence. Tests must cover cross-tenant reads and writes.

Workspace context retrieval has a narrow exception: messages inside the current workspace may inform a model answer, but the transcript cannot be fetched through another teammate’s user-facing history API. Context contains only message content and timestamp; the source author/originator is never identified to the model or in the answer, citations, or UI. Personal history is never included in workspace context. Platform Admin screens contain no conversation content; support access follows the spec’s explicit approval, time limit, and audit requirements.

## Security threat model: OWASP API Security Top 10

The mapping uses [OWASP API Security Top 10 (2023)](https://api-security.owasp.org/editions/2023/en/0x11-t10/). Paths below use the proposed `/api/v1` surface.

| Risk | Momos endpoints / exposure | Mitigation |
|---|---|---|
| **API1 Broken Object Level Authorization** | `GET/DELETE /conversations/{id}`, workspace history retrieval, company/workspace admin resources. | Scope every query by actor, owner, company, and workspace; direct transcript access is owner-only; context retrieval is workspace-only; use opaque IDs; test cross-scope access. |
| **API2 Broken Authentication** | OIDC start/callback, session endpoints, all protected routes. | PKCE/state/nonce, secure rotated sessions, CSRF protection, short session expiry and revocation, MFA for Platform Admins, generic login errors, rate limit sign-in. |
| **API3 Broken Object Property Level Authorization** | `POST /chat`, member/workspace updates, admin settings, profile fields. | Allowlist request fields; derive role/scope server-side; reject client-supplied role/company/workspace ownership fields; return purpose-built response DTOs. |
| **API4 Unrestricted Resource Consumption** | `POST /chat`, history search, bulk deletion, auth and read endpoints. | Enforce the spec’s per-user/IP rate limits, 10,000-character input cap, 50-item pages, 100 in-flight request target, provider deadlines, and bounded context. Apply a global concurrency guard to paid provider calls. |
| **API5 Broken Function Level Authorization** | Company/workspace admin endpoints and `/platform/*`. | Deny by default; authorize every route against the role/scope matrix; only Platform Admin can inspect detailed security/rate-limit events or change global provider settings. |
| **API6 Unrestricted Access to Sensitive Business Flows** | OIDC registration/invites, workspace creation, repeated chat/search requests, admin role changes. | No public Platform Admin registration; Company Admin invites users; idempotency for writes; rate limit creation and chat flows; audit role and tenant changes. |
| **API7 Server Side Request Forgery** | Search/citation handling; any future URL fetch or import feature. | Do not fetch arbitrary citation URLs from the app server. If URL fetching is added, allow only HTTP(S), block loopback/private/link-local IPs after DNS resolution, re-check redirects, and impose egress and response-size limits. |
| **API8 Security Misconfiguration** | All routes, CORS, health endpoints, deployment config, error handling. | TLS, secure cookies, CSRF, explicit CORS origin allowlist, security headers, no debug routes in production, validated startup config, secret manager, generic errors, minimal health output. |
| **API9 Improper Inventory Management** | `/api/v1/*`, health/admin routes, retired versions. | Maintain one route inventory/API spec; expose only deployed versions; remove debug/retired routes; keep health checks minimal and admin diagnostics authenticated. |
| **API10 Unsafe Consumption of APIs** | OIDC, search, model, embedding, and vector-store responses. | Treat provider data as untrusted; validate/normalize schemas, bound response sizes/timeouts, render as escaped text, accept only safe citation URL schemes, redact provider errors, and never follow provider-supplied instructions as system policy. |

Also treat prompt injection in searched pages or recalled chats as untrusted content: it may inform an answer but cannot change system instructions, access controls, or tool permissions. The only exposed agent tool remains web search.

## Caching, jobs, and dependency failures

- Cache versioned static assets only. Do not cache personalized answers, histories, or search results; freshness and account scoping matter more than cache hit rate. Cache public OIDC metadata/JWKS in the auth adapter with bounded expiry.
- Keep chat synchronous to fit the 10-second p95 target. Use a narrow PostgreSQL outbox worker only to synchronize message embeddings with the vector database; do not add a general-purpose queue. Daily encrypted backups are handled by managed PostgreSQL. A small scheduled maintenance task may remove expired idempotency/rate-limit records.
- Do not hold a database transaction open during OIDC, search, embedding, vector-store, or model calls. Use short transactions to retrieve context and to persist messages/citations.
- Index new messages through a PostgreSQL outbox and a retryable background worker so a committed message is not lost if embedding/vector indexing is temporarily unavailable. Until indexing catches up, use keyword/date retrieval; when the vector service is down, continue with PostgreSQL full-text search and report degraded semantic recall in service metrics. On deletion, tombstone the source in PostgreSQL immediately, exclude it from retrieval after candidate revalidation, and retry physical vector deletion until complete.
- Set an overall chat deadline of 10 seconds, with a recommended 4-second search budget, 5-second model budget, and 1 second for validation/persistence/response. Use shorter database connection and statement timeouts. These budgets require load verification.
- Do not automatically retry search/model calls in a chat turn; retries can exceed the deadline or incur duplicate provider cost. The caller can retry with the same idempotency key. Retry a transient database transaction at most once only when no external call has occurred and the operation is safe to repeat.
- If OIDC is down, new sign-ins fail clearly; existing valid sessions can continue while the app and database are healthy. If PostgreSQL is down, protected APIs return 503 and readiness fails. If the vector service is down, retrieval degrades to PostgreSQL full-text/date search. If search/model is down or malformed, the chat request returns a retryable 503/502 and does not fabricate a current answer; history and admin operations remain available if PostgreSQL is healthy.
- A failed chat turn retains a stable idempotency record and clear status so a repeated key cannot create a second user message or charge. Never report an answer as verified unless the search/model flow completed successfully.

## Observability

- Emit structured JSON logs with timestamp, level, request ID, trace ID, route, status, latency, and tenant ID (null for personal accounts). Include actor identifiers only in restricted audit events; never log prompts, answers, tokens, API keys, or sensitive profile data. Redact provider errors before logging.
- Metrics: request count/latency/error by route and status; auth denials; rate-limit hits; database pool/statement latency; provider latency, timeout, and error rates; in-flight chat calls; backup and migration status. Avoid user IDs and conversation IDs as metric labels.
- Trace request, auth, database, history retrieval, search, and model spans with a vendor-neutral tracing interface. Record duration and result category, not prompt/response bodies.
- Provide liveness and readiness checks. Liveness reports process health; readiness requires usable config and PostgreSQL. Provider status is a separate degraded dependency metric, not a reason to hide a healthy history/admin service. Keep diagnostics authenticated and do not return secrets or detailed topology publicly.

## Deployment and configuration

- Deploy one horizontally scalable Node.js service and managed PostgreSQL in an India region when available. Keep user sessions in shared persistence so replicas need no sticky routing. Start with a single application deployment; scale replicas only against the 100-concurrent-request target.
- Keep model, search, OIDC, hosting, and database-vendor choices behind configuration/adapters. Provider selection is deployment configuration, not application logic.
- Validate configuration at startup and fail closed for missing required values. `.env.example` lists every required variable and its purpose; production secrets come from a secret manager/environment injection and never enter source control or logs. Do not commit credentials.
- Apply database migrations as a single deployment step before rolling out compatible application instances. Use additive/expand-contract migrations, never edit an applied migration, and verify migration status before risky changes. Keep app versions compatible with the previous schema during rollout.
- Use managed daily encrypted backups with 30-day retention, RPO 24 hours, and RTO 8 hours. Document and periodically exercise restore procedures. Avoid destructive production migrations or database resets.

## Major decisions and alternatives rejected

1. **Modular monolith.** Chosen for one product and a small team; it keeps transactions and authorization understandable. Rejected alternatives: (a) microservices, because they add deployment/network/consistency work without a measured scaling need; (b) a serverless function per capability, because cross-module authorization, transactions, and tracing become fragmented.
2. **PostgreSQL plus a vector database for hybrid history retrieval.** Chosen because PostgreSQL provides authoritative records, exact-term/date search, and tenant relationships, while vector similarity retrieves semantically related history with different wording. Rejected alternatives: (a) PostgreSQL full-text search alone, which misses meaning-based matches; (b) vector-only retrieval, which is weaker for exact names/phrases and makes relational authorization less direct.
3. **Vendor-independent OIDC and internal role bindings.** Chosen so identity provider claims do not define Momos authorization. Rejected alternatives: (a) custom password authentication, which adds credential storage and recovery risk; (b) trusting provider-specific group/role claims directly, which couples company/workspace permissions to an IdP.
4. **Small provider interfaces.** Chosen because the spec requires vendor agnosticism for model/search/identity/deployment. Rejected alternatives: (a) direct SDK calls throughout the app, which spreads provider-specific formats; (b) a generic plugin marketplace/runtime, which adds unnecessary extension points and security surface.
5. **Versioned JSON API, cursor pagination, and idempotent writes.** Chosen for a stable internal client contract and retry-safe chat turns. Rejected alternatives: (a) unversioned routes and offset pagination, which make evolution and growing-history pages fragile; (b) GraphQL or streaming, which add schema/resolver or partial-citation complexity without a stated need.
6. **Query-layer tenant enforcement with role checks.** Chosen because every query can derive its scope from the authenticated actor and be tested. Rejected alternatives: (a) handler-only checks, which are easy to omit in a new service method; (b) database row-level security as the only boundary, which makes the one-workspace context exception and pooled connection scoping harder to reason about. Row-level policies can be added as defense in depth later.
7. **No response cache or general-purpose queue.** Chosen because answers must be current and history is private; only a narrow outbox worker is needed for vector-index synchronization. Rejected alternatives: (a) Redis for all caches/jobs from day one, which adds an always-on dependency; (b) caching generated answers, which risks stale facts and cross-user context leakage.
8. **Managed Node.js + managed PostgreSQL.** Chosen for a small public service and simpler backup/restore operations. Rejected alternatives: (a) Kubernetes and self-managed database, which add operational overhead; (b) a provider-specific serverless stack, which makes the vendor-agnostic requirement harder to preserve.
9. **Content-free structured observability.** Chosen to diagnose latency and failures while protecting private chats. Rejected alternatives: (a) logs only, which cannot show trends or provider bottlenecks; (b) full prompt/response logging, which creates unnecessary privacy and breach impact.

## Decisions to confirm

- **API route prefix:** The spec names routes such as `/api/chat`; this design proposes `/api/v1/chat` to make breaking API changes manageable. Confirm whether to introduce the version prefix in the first release.
- **Provider configuration:** Which OIDC, model, web-search, embedding, and vector-database providers and credentials will be enabled for the first deployment? The interfaces remain vendor-agnostic either way.
- **Platform Admin support access:** Who approves exceptional access to personal or workspace conversation content, and what is the audit-event retention period? Recommended default: the personal-chat owner approves personal content; the Company Admin approves workspace content; retain content-free audit/rate-limit events for 90 days.
- **Rate-limit storage:** The simple default is atomic PostgreSQL counters and event rows. Choose Redis only if load testing shows database contention or if an asynchronous queue is later required.
- **Provider deadlines:** Confirm the 4-second search / 5-second model budgets against the selected providers and the 10-second end-to-end target.
- **Platform Admin bootstrap:** Confirm that the initial Platform Admin is provisioned through a private deployment/bootstrap process and that MFA is mandatory.
