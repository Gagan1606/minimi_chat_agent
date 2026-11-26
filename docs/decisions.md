use typescript
the evaluator is an assessment function, not an application role or product user; use the assessment criteria to guide implementation
there is no developer, operator
agents.md and product_req.md together must be seen as guidelines there is no need to check if both of them contain all the points, only check if they collectively make sense and if there are any contradictions

historical convo recall - we need to brainstorm ideas to make that feature exist
"The quality target is not measurable." - its trigger sentecnes werent meant to be taken at the face value

design.md, plan.md, spec.md documents dont exist yet, we need to ideate and create it, ill let you know when; it is mentioned in the agents.md so that new sesion can resume work just by reading agents.md, it makes complete sense when design doc is produced

ignore the placeholders, thats a tiny error from my side

## Working decisions (updated 2026-11-24 15:56 IST)

This section incorporates `docs/resolutions.md` and supersedes the earlier appended decisions where it is more specific.

1. **Runtime and product surface**
   - Use TypeScript on Node.js.
   - Build a responsive browser-based chat app with saved conversation history and a new-chat action.

2. **Identity and privacy boundary**
   - Require sign-in to save history. Use managed OpenID Connect authentication, with Google sign-in as the initial provider.
   - Keep each user's conversations private to that account. Do not offer anonymous saved history in the MVP.
   - Include only the current question and relevant retrieved history snippets in model requests; do not send unrelated conversation history.

3. **Conversation recall and accuracy**
   - Support recall of a user's prior conversations across sessions. Provide a chronological history list and date/keyword lookup.
   - Implement recall inside the app's history service; expose web search as the agent's only tool.
   - Use deterministic account scoping, timestamps, date filters, and PostgreSQL full-text search to find relevant messages. Let the model interpret the question and summarize retrieved material. Do not add vector search unless evaluation shows it is needed.
   - Recall accuracy depends on both architecture and model quality. Architecture controls whether the right user's messages and relevant time period are retrieved; the model affects interpretation and synthesis. A stronger model cannot recover messages the system failed to retrieve.
   - If a date or reference is ambiguous, ask the user to clarify rather than inventing a match.

4. **Dates and timezone**
   - Treat users and date references as India-based. Interpret relative dates in `Asia/Kolkata` (IST), and store timestamps in UTC.
   - Display dates in IST. For an ambiguous date without a clear year, ask for clarification.

5. **Model and web search**
   - Use the available Gemini API key for the initial model integration. Keep model calls behind a provider interface and make the model name configurable; do not make application logic depend on Gemini-specific response formats.
   - Use Google Search grounding through the Gemini adapter for the initial web-search capability. Keep the search capability behind its own interface so a different search provider can replace it later.
   - Render returned source links as citations. Show the access/check date in IST and the publication date when available; never infer a publication date. State when sources conflict or evidence is weak.
   - The [official Gemini Search grounding documentation](https://ai.google.dev/gemini-api/docs/google-search) describes real-time search and citation annotations. Verify current model eligibility, quotas, and charges before public release because these can change.
   - Do not set product usage quotas yet. Handle upstream rate-limit or provider failures clearly, without presenting an unverified answer as confirmed.

6. **Retention and backups**
   - Keep conversations until the user deletes them. Provide controls to delete one conversation or all history.
   - Remove deleted conversations from the active database and search index immediately. Daily encrypted backups are retained for 30 days, so deleted records may remain in backup copies until those copies expire.
   - Target an RPO of 24 hours and RTO of 8 hours for the initial service.
   - Do not log conversation contents, credentials, or sensitive personal data. Minimize provider-side retention where the provider settings allow it.

7. **Deployment and service targets**
   - Target a small public deployment on managed Node.js hosting, with an India region preferred when available. Use PostgreSQL as the source of truth; add infrastructure only when measured needs justify it.
   - Initial targets: p95 end-to-end response time of 10 seconds for ordinary search questions, 100 concurrent requests, and 99.5% monthly availability. Treat these as starting engineering targets, not a contractual SLA.
   - Validate the latency and concurrency targets under representative load before a wider release.

8. **Payments, integrations, and data scope**
   - Exclude payments from the MVP. Integrations are limited to authentication, PostgreSQL storage, Gemini, and web search.
   - Collect only data needed for chat and recall. Do not target regulated or sensitive-data use cases in the MVP. Review applicable privacy and data-handling requirements before public launch.

9. **Evaluation**
   - The evaluator is an assessment function, not an application role or product user. Use representative tasks covering current facts, product/pricing changes, history recall, IST date interpretation, conflicting or weak sources, privacy isolation, and provider failures to guide implementation and assess the final product.
   - Assess source support, factual correctness, uncertainty handling, cross-user isolation, and the p95 latency target. Treat the sample prompts in `product_req.md` as coverage hints rather than literal acceptance tests.
   - Maintain a small repeatable evaluation set; do not claim a numeric accuracy target until the evaluator's rubric or dataset is available.

### Remaining implementation checks

- Confirm the available Gemini project supports the selected model and Google Search grounding, and check current provider quotas and charges before deployment.
- Choose the managed hosting and PostgreSQL vendors; prefer an India region where available.
- Exercise the 10-second p95 and 100-concurrent-request targets with a representative workload.
- Confirm any required legal, privacy, or data-residency constraints before public launch; no specific compliance regime was supplied.

## Resolutions incorporated 2026-11-24 17:18 IST

This section incorporates `docs/resolutions.md` and the items marked “cool” in `docs/SPEC.md`. The personal-chat privacy rules below apply to personal chat; team workspace chat has its own explicit sharing boundary.

### Application modes

1. **Personal chat**
   - A personal chat is accessible only to its owner.
   - Its history is saved in that user's account and is available only as context for that user's personal chats.
   - Personal-chat history is not included in team workspace context.

2. **Team workspace chat**
   - The application supports a workspace for each team.
   - Each teammate has an individual chat space inside the workspace.
   - Those chats are stored as part of the team's history. A teammate's workspace chat may be retrieved as context for another teammate's workspace chat within the same team.
   - Team workspace history is isolated from other teams and from each member's personal-chat history.
   - **Proposed safeguard:** Clearly label workspace chats as team-shared context and show which teammate/conversation supplied recalled information, with its date. This makes the sharing behavior visible to users.

### Approved security and abuse-protection assumptions

The following `SPEC.md` assumptions marked “cool” are adopted as working decisions:

- Enforce account/workspace ownership for every history read, write, and delete in the data-access path. Personal history is owner-only; workspace history is scoped to the member's team workspace.
- Use TLS 1.2 or newer for browser-to-service and service-to-provider traffic. Use `Secure`, `HttpOnly`, `SameSite=Lax` or stricter session cookies, and CSRF protection for cookie-authenticated state-changing requests.
- Use parameterized database queries: pass user-supplied values to the database as bound parameters, separate from the SQL command structure. Do not construct SQL by concatenating user input. This prevents input from being interpreted as executable SQL.
- Validate external input before business processing: check its shape, type, required fields, allowed values, format, and size against a schema; reject invalid input with a consistent client error. Validation checks that input is well-formed; it does not replace authentication, authorization, or parameterized queries.
- Use the following initial abuse-protection rate limits. These are request safeguards, not billing plans or product usage quotas:
  - OIDC sign-in start: 10 requests per IP per 15 minutes.
  - Chat writes: 30 requests per signed-in user per minute.
  - Conversation list/detail reads: 120 requests per signed-in user per minute.
  - Conversation deletions: 10 requests per signed-in user per hour.

### Admin portal visibility — approved

The user approved the previously proposed admin visibility boundary. The application has an authorized platform-level admin portal.

- **Approved platform-admin access:** retain global authority to create, suspend, or restore company tenants and workspaces; view platform-wide health and aggregate usage; inspect detailed provider, security, and rate-limit events; and audit global administrative actions. Routine company and workspace membership administration belongs to the scoped roles defined below.
- **Approved content boundary:** Routine admin views do not expose personal-chat contents, workspace-chat contents, prompts, model answers, or citations. Exceptional support access to conversation content requires separate explicit approval, is time-limited, and is audited.
- **Reasoning:** Admins need controls to operate accounts and diagnose service health. Routine access to conversation text would expose user research without being necessary for those tasks. Aggregate metrics and content-free audit events provide operational visibility while preserving the personal/workspace privacy boundaries.

### Documentation consistency note

`docs/SPEC.md` currently lists team workspaces and shared conversations as out of scope. That statement predates these resolutions and must be reconciled when the spec is next updated.

## Company and platform administration resolutions (updated 2026-11-24 17:32 IST)

This section incorporates the latest `docs/resolutions.md`. It supersedes the earlier note that there is no developer/operator: the product has a platform-level administrator, separate from company users and workspace admins.

### Customer and tenancy model

- The two primary customer types are individuals using personal chat and companies using Momos as an internal tool.
- A company is a tenant and may contain multiple team workspaces.
- Each company has a company admin who can assign workspace admins.
- Each workspace has its own workspace admin.
- Personal chat remains visible and recallable only by its owner.
- Within a team workspace, each teammate has an individual chat space. Workspace chat history belongs to that workspace and may be retrieved as context for another teammate's chat in the same workspace.
- **Working isolation rule:** A workspace's chat history is available only within that workspace; chats from another workspace in the same company are not included unless explicitly shared later. Personal chat history is never included in team context.

### Named administrator roles and scopes

Use these role names consistently in the product and documentation: **Workspace Admin**, **Company Admin**, and **Platform Admin**.

| Role | Scope | Proposed privileges | Explicit limits |
|---|---|---|---|
| **Workspace Admin** | One team workspace | Invite/remove ordinary members in that workspace; update workspace settings; see workspace-level aggregate usage and status. | Cannot appoint or remove Workspace Admins, administer sibling workspaces, or manage company membership. Admin status does not grant access to personal chats. Team chat context is shared within the workspace according to the workspace-sharing rule. |
| **Company Admin** | One company tenant and its workspaces | Create/archive workspaces within the company; manage company membership; assign/remove Workspace Admins; view company and per-workspace status and aggregate usage. | Cannot administer other companies or change platform-wide provider settings. Does not automatically become a member of every workspace and gets no conversation-content access beyond workspace membership. |
| **Platform Admin** | Entire Momos service | Create/suspend/restore companies and workspaces; assign/remove Company Admins; configure platform providers and deployment settings; view service-wide and per-tenant aggregate health/usage; inspect detailed security, provider, and rate-limit events; perform audited support actions. | Must not view conversation content in routine dashboards. Exceptional content access follows the approved, explicit, time-limited, audited process. |

- Workspace chat context can be used by teammates only within the same workspace. Personal chat history is excluded from every team workspace.
- **Proposed safeguard:** Clearly label workspace chats as team-shared context and show which teammate/conversation supplied recalled information, with its date.
- **Proposed safeguard:** Workspace Admin and Company Admin views should show only aggregates and administration metadata. Detailed security and rate-limit events are Platform Admin-only.

### Application-wide platform administrator — proposal

This role represents the application owner/operator and is distinct from Company Admin and Workspace Admin. The prior high-level admin visibility boundary is approved; the following dashboard layout and role split are the detailed proposal.

- **Dashboard:** Show platform health, model/search provider status, latency/error summaries, aggregate request and usage counts, detailed rate-limit/security events, and backup/recovery status. Where available, show aggregate provider spend. Exclude conversation contents.
- **Tenant controls:** Create, suspend, restore, and archive companies/workspaces; assign Company Admins; inspect tenant/workspace status; and view the minimum membership identity data needed for account administration.
- **Provider controls:** Configure model/search adapters and rotate credentials without revealing stored secret values. Show provider quotas and usage summaries.
- **Audit controls:** Review sign-ins, membership/role changes, deletions, provider/configuration changes, and privileged actions. Record actor, action, target, time, and outcome without message content or secrets.
- **Content boundary:** Keep personal and workspace conversation contents, prompts, answers, and citations out of routine Platform Admin screens. Exceptional support access follows the approved, explicit, time-limited, audited process above.
- **Proposed privileged-account safeguards:** Require MFA, prohibit public self-registration for Platform Admins, and audit every privileged action.
- **Reasoning:** Platform Admins need whole-service controls and diagnostics; Company Admins need to organize their company; Workspace Admins need to manage one team. Separating these scopes limits accidental cross-company access and keeps routine security diagnostics away from customer admins.

### Rate-limit events

- A **rate-limit event** is a record created when a request hits a configured request-frequency threshold and is throttled or rejected. It is operational/security metadata, not a general chat log or a record of the user's prompt or answer.
- **Proposed event fields:** timestamp, request ID, rate-limit rule, endpoint/category, outcome, and the relevant user/workspace/company identifiers. Do not include prompt text, model output, API keys, or other conversation content. IP addresses should be omitted unless a concrete abuse investigation requires them.
- Detailed events are visible only to Platform Admins. Company Admins and Workspace Admins do not see the event stream; they may see ordinary aggregate usage/status but not individual users' throttling or security events.
- Example: “Chat-write limit reached for workspace W at 14:05 IST; request rejected; rule `chat-write-per-user`.” This supports diagnosis of abuse or misconfiguration without exposing chat content.

`docs/SPEC.md` should be updated in a later spec pass to include individual customers, company tenants, multiple workspaces, the three administrator roles, rate-limit event visibility, and the approved sharing boundaries. The detailed dashboard layout and privileged-account safeguards remain proposals for review.
