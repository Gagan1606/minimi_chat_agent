# Momos Product Specification

This specification is based on `docs/product_req.md` (P), `docs/decisions.md` (D), and the latest direction in `docs/resolutions.md` (R). Requirements cite their source; simple MVP defaults are selected directly in the relevant sections.

Trace notation: `P:n`, `D:n`, and `R:n` refer to line numbers in those files. R directs sensible defaults for unanswered questions (R:1) and vendor/model/provider agnosticism (R:2). R:2 supersedes vendor-specific selections in D where they conflict.

## 1. Goals

- Provide a conversational agent whose only exposed tool is web search. [P:5]
- Serve individuals using personal chat and companies using Momos as an internal tool. Companies may contain multiple team workspaces. [D:121-127]
- Keep personal chat private to its owner and allow prior workspace chats to inform another chat only within the same workspace. For context, use only message content and timestamp; never include the asker’s or source conversation’s originator identity in context, prompts, tool inputs, citations, UI, or generated output. Identity and scope may be used server-side only for authentication, authorization, and workspace filtering. Other teammates' chats are model context, not directly browsable. [D:77-86, 125-127; user clarification, 2026-11-25]
- Provide a responsive browser chat experience, implemented in TypeScript on Node.js. [P:22-23; D:17-19]
- Answer current questions with sources, communicate uncertainty, and interpret dates in IST. [P:17-18; D:34-40]
- Retrieve relevant conversation history by exact-word matching and semantic similarity, so related meaning can inform a response even when wording differs. [User direction, 2026-11-25]
- Prioritize architecture quality, correctness, speed, and conversational quality over feature count or visual polish. [P:17-18]
- Use replaceable model, search, identity, hosting, and storage-vendor integrations rather than making product logic depend on a single vendor. [P:25; R:2; D:38-41]

## 2. Explicit non-goals

- Payments are out of scope for the MVP. [D:55-57]
- Regulated or sensitive-data use cases are out of scope for the MVP. [D:57]
- Anonymous saved history is out of scope. [D:22-23]
- The agent exposes web search as its only tool. History retrieval is an application service, not another agent tool. [P:5; D:27-29]
- History retrieval combines PostgreSQL full-text search and date filters with semantic vector search over relevant conversation history. [User direction, 2026-11-25; supersedes D:29]
- Product usage quotas are not set in this phase. Approved request rate limits are abuse safeguards, not billing quotas. [D:42, 97-101]
- Workspace history does not cross workspace boundaries, including between workspaces in the same company. [D:127]
- Routine admin interfaces do not expose conversation content; exceptional support access must be explicit, time-limited, and audited. [D:107-109, 137, 151]
- No anonymous chat mode, company-wide search across all workspaces, or public sharing links are included in the MVP. Workspace context is scoped to the current workspace. [D:22-23, 127; R:1]
 
## 3. Product roles, stories, and assessment guidance

### Individual user

**Story I-1 — Personal chat**  
As an individual, I want private chat with persistent history so I can use Momos as a daily assistant.

- **Given** I am signed in, **When** I create a personal chat and send a message, **Then** the conversation is saved to my account and accessible only to me. [D:22-24, 77-80]
- **Given** I have personal history, **When** I ask a follow-up that needs recall, **Then** the application searches my history and sends only relevant snippets with my current question to the model. [D:24, 27-30]
- **Given** team workspace chats exist, **When** I use personal chat, **Then** workspace history is not used as personal-chat context. [D:80, 127]

**Story I-2 — Current information**  
As a user, I want current answers with sources so I can judge whether they are useful.

- **Given** I ask a current-information question, **When** the agent answers, **Then** it uses web search as its only exposed tool and includes returned source links as citations. [P:5; D:28, 39-40]
- **Given** sources conflict or evidence is weak, **When** the agent responds, **Then** it identifies the uncertainty and does not present an unverified answer as confirmed. [D:40, 42]
- **Given** citation metadata is available, **When** the answer is displayed, **Then** it shows the access/check date in IST and the publication date when available, without inventing a date. [D:40]

**Story I-3 — Personal history controls**  
As a user, I want to delete my saved history.

- **Given** I own a conversation, **When** I delete it, **Then** it is removed from active storage and the search index. [D:45-46]
- **Given** I request deletion of all personal history, **When** deletion completes, **Then** my conversations are removed from active storage and the search index; retained backup copies expire within 30 days. [D:45-46]

### Company member / workspace teammate

**Story W-1 — Workspace chat and shared context**  
As a company teammate, I want my own chat space inside a team workspace and useful context from prior workspace chats.

- **Given** I am a member of workspace A, **When** I ask a question that needs team context, **Then** relevant messages from workspace A may inform the answer using only their content and timestamp; neither my identity nor the source conversation's originator identity is sent to the model or shown in the answer. [D:84-86, 126-127; user direction, 2026-11-25]
- **Given** a conversation belongs to a different workspace or a member's personal account, **When** I use workspace A, **Then** that conversation is not included in the context. [D:80, 86, 127]
- **Given** another teammate's workspace messages inform my answer, **When** the model uses them, **Then** each context item contains only message content and timestamp; source identity, role, and conversation identifiers are excluded, and the source transcript is not directly browsable. [User direction, 2026-11-25; D:84-86, 126-127]
- The interface tells members that workspace messages can inform teammate answers, without exposing the source transcript or identifying its originator. [D:84-86, 126-127; R:1; user direction, 2026-11-25]

### Workspace Admin

**Story WA-1 — Administer one workspace**  
As a Workspace Admin, I want to manage my team's workspace without managing the company.

- **Given** I administer workspace A, **When** I invite or remove an ordinary member or change workspace settings, **Then** the change applies only to workspace A. [D:133-135; R:1]
- **Given** I am a Workspace Admin, **When** I try to appoint another Workspace Admin or manage company membership, **Then** the action is denied; only the Company Admin may assign Workspace Admins. [D:123, 135-136; R:1]
- **Given** I view workspace administration information, **When** the dashboard is displayed, **Then** it shows workspace status and aggregate usage, without the detailed security/rate-limit event stream. [D:135, 141, 159]

### Company Admin

**Story CA-1 — Administer one company**  
As a Company Admin, I want to manage my company's workspaces and assign their admins.

- **Given** the Platform Admin has created company C and designated me as its Company Admin, **When** I set up the company, **Then** I can invite members and assign each one to a workspace in C. [D:123, 136; R:1]
- **Given** I administer company C, **When** I assign or replace a Workspace Admin, **Then** the assignment applies only to a workspace in C. [D:123, 136]
- **Given** I administer company C, **When** I create or archive a workspace or manage company membership, **Then** the action applies only within C. [D:136; R:1]
- **Given** another company has a workspace, **When** I list or manage workspaces, **Then** I cannot see or administer that other company's workspace. [D:136]
- **Given** I am not a member of a workspace, **When** I administer the company, **Then** I do not automatically gain access to its conversation content. [D:136]
- **Given** I view company administration information, **When** the dashboard is displayed, **Then** it shows company/workspace status and aggregate usage, without detailed individual security/rate-limit events. [D:136, 141, 159]

### Platform Admin

**Story PA-1 — Operate the Momos service**  
As a Platform Admin, I want to operate the whole service and diagnose issues while respecting conversation privacy.

- **Given** I am a Platform Admin, **When** I open the platform dashboard, **Then** I can view platform health, provider status, aggregate usage, and backup/recovery status. [D:137, 143-153; R:1-2]
- **Given** a request hits a rate limit, **When** I investigate it, **Then** I can see its rate-limit event metadata; Company Admins and Workspace Admins cannot see that detailed event stream. [D:141, 157-160]
- **Given** I use routine admin screens, **When** I inspect a tenant, **Then** personal/workspace message content, prompts, answers, and citations are not displayed. [D:108, 137, 151]
- **Given** exceptional support requires conversation content, **When** access is granted, **Then** it requires separate explicit approval, is time-limited, and is audited. [D:108, 151]
- Platform Admin authentication requires MFA. The role cannot be publicly self-registered; the first Platform Admin is provisioned through private deployment bootstrap and later Platform Admins are invited by an existing one. [D:152; R:1]

### Assessment guidance (not an application role)

Assessment criteria guide implementation choices and quality checks; they do not define a product user or permission role. [D:2, 59-62]

- **Given** representative tasks cover current facts, pricing/feature changes, recall, IST dates, uncertain/conflicting sources, privacy, and provider failures, **When** the application is evaluated, **Then** results can be assessed for source support, factual correctness, uncertainty handling, privacy isolation, and latency. [D:59-62]
- **Given** example prompts are included in evaluation, **When** they are run, **Then** they are treated as coverage hints, not literal acceptance tests. [P:9-13; D:61]
- Do not claim a numeric accuracy target until an evaluation rubric or dataset is available. [D:62]
- A repeatable evaluation harness records prompt, expected behavior, observed answer, citation links, and elapsed time. [D:62; R:1]

## 4. Functional requirements

| ID | Requirement | Trace |
|---|---|---|
| **FR-1** | The product shall provide personal chat for individuals and workspace chat for company teammates. | D:121, 125-127 |
| **FR-2** | The product shall provide a responsive browser chat with a new-chat action, implemented in TypeScript on Node.js. | P:22-23; D:17-19 |
| **FR-3** | Persistent history shall require sign-in through a vendor-independent OIDC integration. | D:22-23; R:2 (supersedes the initial named provider in D:22) |
| **FR-4** | Personal conversations shall be readable and recallable only by their owner. | D:77-80, 125 |
| **FR-5** | A person belongs to one company and one workspace at a time. A company may have multiple workspaces. | User clarification to prior SPEC question 1; D:122-124 |
| **FR-6** | Each company shall have one Company Admin, and each workspace shall have one Workspace Admin. The Company Admin assigns or replaces the Workspace Admin; the Platform Admin can replace the Company Admin. | D:123-124; R:1 |
| **FR-7** | Each teammate shall have a separate workspace chat space. Its history may be used only as model context for chats in that same workspace. Context contains only message content and timestamp; asker and source-originator identities, message roles, and conversation identifiers are not sent to the model or exposed in answers, citations, or UI. Teammates cannot directly browse another teammate's chat space. | D:84-86, 126-127; user direction, 2026-11-25 |
| **FR-8** | Personal history shall never be included in team context. Workspace history shall not cross workspace boundaries unless explicitly shared later. | D:80, 127 |
| **FR-9** | Model, web-search, identity, hosting, and storage-vendor integrations shall use replaceable interfaces/configuration; application behavior shall not depend on provider-specific response formats. No specific model/vendor/provider is fixed by this spec. | P:25; R:2; D:38-41 (provider-specific choices superseded) |
| **FR-10** | The agent shall expose web search as its only tool; conversation recall shall be performed by an application history service. | P:5; D:27-29 |
| **FR-11** | Answers shall display returned source links as citations, show the access/check date in IST and publication dates when available, and identify weak or conflicting evidence. | D:40 |
| **FR-12** | The application shall retrieve history using account/workspace scoping, timestamps, date filters, PostgreSQL full-text search, and semantic vector search, combining exact-term and meaning-based matches. | D:29, 34-35, 93; User direction, 2026-11-25 (adds vector search and supersedes deferral in D:29) |
| **FR-13** | The application shall send only the current question and relevant retrieved snippets to the model, not unrelated history. | D:24 |
| **FR-14** | Relative dates shall use `Asia/Kolkata`; timestamps shall be stored in UTC and dates displayed in IST. Ambiguous references shall trigger clarification. | D:31, 34-35 |
| **FR-15** | Users shall be able to delete one conversation or all history; deletion shall remove records from active storage and keyword/vector search indexes so deleted history cannot be recalled. | D:45-46; User direction, 2026-11-25 |
| **FR-16** | Deleted conversation data may remain in encrypted daily backups for no more than 30 days. | D:46 |
| **FR-17** | Enforce the admin scopes and content boundaries. The Platform Admin dashboard shows provider/service status, aggregate usage, security and rate-limit events, and backup/recovery status; customer admins see company/workspace aggregates only. | D:103-109, 133-153, 157-160; R:1 |
| **FR-18** | Detailed rate-limit and security events shall be visible only to Platform Admins. Company Admins and Workspace Admins may see aggregate usage/status, not the detailed event stream. | D:141, 155-160 |
| **FR-19** | A rate-limit event shall contain operational metadata about a request that hit a threshold and was throttled/rejected, excluding prompt and answer content. | D:157-160 |
| **FR-20** | External inputs shall be schema-validated before business processing; database queries shall use bound parameters, not SQL constructed by concatenating input. | D:95-96 |
| **FR-21** | The application shall use the approved TLS/session-cookie/CSRF safeguards and per-operation rate limits. | D:94, 97-101 |
| **FR-22** | Logs shall exclude conversation contents, credentials, and sensitive personal data; provider-side retention shall be minimized where settings allow. | D:48 |
| **FR-23** | All required API keys shall be listed in `.env.example`; credentials shall not be committed. The variables are provider-specific configuration, not application logic. | P:24; R:2 |
| **FR-24** | Payments and regulated/sensitive-data use cases shall be excluded from the MVP. | D:55-57 |
| **FR-25** | Assessment tasks shall cover current facts, changes, personal/workspace recall, IST interpretation, uncertainty, privacy isolation, and provider failures. | D:59-62 |
| **FR-26** | Use a small JSON API: `POST /api/chat` with personal/workspace scope, `GET /api/conversations` with cursor pagination, `DELETE /api/conversations/{id}`, `DELETE /api/me/history`, and scoped admin endpoints for company/workspace operations and rate-limit events. Return complete JSON responses. Limit a message to 10,000 characters and a history page to 50 conversations. | R:1 |
| **FR-27** | The Platform Admin creates a company and designates its first Company Admin. The Company Admin invites company members and assigns each to one workspace. | D:123, 137-149; R:1 |

## 5. Non-functional requirements

### Latency and capacity

Chat time is measured end-to-end. Other endpoint time is measured server-side from request receipt to response completion, excluding client network time. [D:52-53; R:1]

| Key endpoint | p95 target | Status/trace |
|---|---:|---|
| `POST /api/chat` (personal or workspace) | ≤ 10 seconds for ordinary search questions | D:52 |
| `GET /api/conversations` | ≤ 500 ms | MVP target [R:1] |
| `GET /api/conversations/{id}` | ≤ 500 ms | MVP target [R:1] |
| `DELETE /api/conversations/{id}` | ≤ 1 second | MVP target [R:1] |
| `DELETE /api/me/history` | ≤ 2 seconds | MVP target [R:1] |
| `GET /api/admin/overview` | ≤ 1 second | MVP target [R:1] |
| `GET /api/admin/rate-limit-events` | ≤ 500 ms | MVP target [R:1] |
| Company/workspace admin mutations | ≤ 1 second | MVP target [R:1] |

- Capacity: 100 concurrent requests. [D:52]
- Target 10 chat requests/second sustained and 20 chat requests/second for bursts up to 30 seconds, capped at 100 in-flight requests. Confirm representative load and provider capacity before wider release. [D:41-42, 52-53; R:1]
- Non-chat p95 targets and RPS are initial engineering budgets, not contractual SLAs. [R:1]

### Availability and recovery

- Monthly availability target: 99.5%. [D:52]
- RPO: 24 hours. RTO: 8 hours. [D:47]
- Backups: daily, encrypted, retained for 30 days. Deleted data may remain in backup copies until expiry. [D:46]
- Use managed Node.js hosting and prefer an India region where available; PostgreSQL is the system of record. Keep the hosting and database vendor replaceable. [D:51; R:2]

### Security and privacy

- Personal history is owner-only; workspace history is scoped to that workspace; Company Admin actions are scoped to one company; Platform Admin has service-wide scope. [D:77-86, 123-139]
- Use bound SQL parameters; do not concatenate user input into SQL. [D:95]
- Validate input shape, type, required fields, allowed values, format, and size before business processing; reject invalid input with a consistent client error. [D:96]
- Use TLS 1.2 or newer; session cookies must be `Secure`, `HttpOnly`, and `SameSite=Lax` or stricter; use CSRF protection for cookie-authenticated state-changing requests. [D:94]
- Send only the current prompt plus relevant history; do not log conversation contents, credentials, or sensitive personal data. Minimize provider-side retention where possible. [D:24, 48]
- Routine admin surfaces exclude conversation content. Exceptional support access requires explicit approval, time limits, and audit. [D:108, 151]
- Require MFA for Platform Admins, prohibit public self-registration, and provision the first Platform Admin through private deployment bootstrap; existing Platform Admins may invite additional Platform Admins. [D:152; R:1]

### Rate limits

These are approved abuse safeguards, not product usage quotas. [D:42, 97-101]

| Operation | Limit | Scope |
|---|---:|---|
| OIDC sign-in start | 10 per IP per 15 minutes | IP |
| Chat writes | 30 per minute | Signed-in user |
| Conversation list/detail reads | 120 per minute | Signed-in user |
| Conversation deletions | 10 per hour | Signed-in user |

On application or upstream throttling, return a clear retryable failure and do not claim an unverified search result. [D:42]

## 6. Conceptual data entities and relationships

The following entities describe the conceptual data model; physical schema details follow these relationships.

- **Person / identity:** Signed-in individual linked to a vendor-independent OIDC subject. Store only the minimum identity/profile information required. [D:22, 57; R:2]
- **Company tenant:** A company using Momos; one company may contain multiple workspaces. [D:121-123]
- **Company membership:** Links one person to one company and records whether the person is its Company Admin. A person can have only one company membership at a time. [User clarification to prior SPEC question 1]
- **Workspace:** Belongs to one company and represents one team. [D:122]
- **Workspace membership:** Links one person to one workspace and records member or Workspace Admin status. A person belongs to one workspace at a time. [User clarification to prior SPEC question 1; D:124]
- **Platform Admin assignment:** Grants global service scope separately from company/workspace roles. [D:117, 137]
- **Personal conversation:** Belongs to one person and is accessible only to that person. Store an opaque identifier and timestamps. [D:77-80; R:1]
- **Workspace chat space/conversation:** Belongs to one workspace and has an originating teammate recorded for ownership and authorization. Its messages may be retrieved as model context for other conversations in that workspace, but the originator is never identified in context, prompts, tool inputs, answers, citations, or UI. [D:84-86, 126-127; user direction, 2026-11-25]
- **Message:** Belongs to one personal or workspace conversation and records role, content, and UTC timestamp. For workspace context, only content and timestamp are supplied to the model; role and originator identity remain excluded. [D:24, 34; R:1; user direction, 2026-11-25]
- **Semantic index record:** A vector representation linked to a message for meaning-based retrieval, with scope/status metadata used only to filter and authorize candidates; it follows the same personal/workspace access scope and deletion lifecycle as its source message. Only message content and timestamp may enter context supplied to the model. [User direction, 2026-11-25]
- **Citation:** Associates source metadata with an assistant answer, including URL, check date, and optional publication date. [D:40; R:1]
- **Audit event:** Records administrator, action, target, time, and outcome, excluding secrets and conversation content. [D:150]
- **Rate-limit event:** Records the rule, endpoint/category, request ID, time, outcome, and relevant user/company/workspace identifiers, excluding prompts and answers. [D:157-160]

Relationships:

- One company contains multiple workspaces; each workspace belongs to one company. [D:122]
- A company has one Company Admin and each workspace one Workspace Admin for the MVP. The Company Admin replaces a Workspace Admin before removal; the Platform Admin replaces a Company Admin if needed. [User clarification to prior SPEC question 3; D:123-124; R:1]
- One person has one company membership and one workspace membership at a time; personal chat remains a separate private scope. [User clarification to prior SPEC question 1; D:77-80]
- A workspace conversation is associated with its originating teammate and workspace for ownership and authorization; context retrieval may use other conversations from that workspace only. Originator/requester identity is excluded from model context and output; only message content and timestamp may be used as context. [D:84-86, 126-127; user direction, 2026-11-25]
- Assistant answers may have zero or more citations. [D:40; R:1]
- Deleting history removes affected records and citations from active storage and search indexes; backup copies expire under the 30-day rule. [D:45-46; R:1]

## 7. Traceability key

- **P** — `docs/product_req.md`, line numbers.
- **D** — `docs/decisions.md`, line numbers.
- **R** — `docs/resolutions.md`, line numbers.
