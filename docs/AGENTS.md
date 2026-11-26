# Project Name: momos

## Context
- momos is [one-sentence description].
- Stack: refer docs/DESIGN.md
- Before any architectural, schema or API work, read docs/DESIGN.md. Requirements are in docs/SPEC.md and the milestone plan is in docs/PLAN.md.
- Never edit docs/product_req.md.

## Development Commands

### Application
- Development: `npm run dev`
- Production build: `npm run build`
- Production start: `npm run start`

### Quality Checks
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Format: `npm run format`
- Format check: `npm run format:check`

### Tests
- Run all tests: `npm test`
- Run a single test file: `[command, e.g. npm test -- path/to/file.test.ts]`
- Watch tests: `npm run test:watch`

### Database
- Run migrations: `[command]`
- Create a new migration: `[command]`
- Roll back last migration: `[command]`
- Seed dev data: `[command]`
- Reset dev database (dev only, ask first): `[command]`

### Environment
- Env vars are documented in `.env.example`. Never read `.env`.

### Infrastructure
- Start dependencies: `docker compose up -d`
- Stop dependencies: `docker compose down`
- Check services: `docker compose ps`
- View logs: `docker compose logs -f`

## Definition of Done
- Typecheck, lint and relevant tests pass.
- Run the production build for release-ready tasks.
- Docs are updated if behavior changed.
- Give a summary of what changed.
- Never claim a command succeeded unless it was actually executed.
- If a command fails, investigate and report the failure.

## Testing
- Write tests first and show them failing before implementing.
- Integration tests use a real Postgres/Redis from docker compose, no database mocks.
- Every endpoint needs tests for: success, invalid input, unauthenticated, wrong role, and cross-tenant access.
- Assert side effects (database state, queued jobs), not just status codes.

## Permissions
- Ask before adding dependencies.
- Ask before destructive database operations.
- Ask before changing architecture or security boundaries.
- Never expose secrets or read .env files.
- Never commit credentials.

## Workflow
- Inspect before editing.
- Explain existing behavior before changing it.
- For non-trivial work, propose a plan first.
- List affected files, risks and verification steps.
- Wait for approval before implementing planned work.
- Implement in small, reviewable tasks.
- Run relevant tests, lint and typecheck.
- Explain important design decisions.
- Do not silently expand scope.
- if a file containing "ASSUMPTION" tags is involved in an task assigned, check if it is the safest and most sensible assumption and move ahead.
- always verify if given permissions and resources for a given task are suffiecient, ask if not. 

## Security
- Use parameterized queries only, never string-built SQL.
- Every endpoint must enforce authorization. Tenant scoping is applied in the query layer.
- Rate limit auth and write endpoints.

## API Errors
- Use one consistent API error response format: [state the schema, or "see docs/DESIGN.md"].
- Do not expose stack traces or internal implementation details to clients.

## Validation
- All external input must be validated using the project's chosen validation library.
- Keep validation schemas separate from business logic.
- Reject invalid input with consistent client errors.

## IDs
- Public IDs are [decided strategy, e.g. UUIDv7]. Never expose sequential database IDs.

## Transactions
- Use database transactions whenever a business operation changes multiple related records that must remain consistent.
- Keep transactions as short as possible.
- Never perform slow external network calls while holding a database transaction open.
- Transactions are owned by the [service/repository] layer.

## Logging and Privacy
- Use structured logging.
- Never log passwords, authentication tokens, API keys, secrets or sensitive personal data.
- Redact sensitive fields before logging errors or request metadata.
- Include the request ID and tenant ID in every log entry, without logging unnecessary personal information.

## Database Safety
- Never edit an already-applied migration.
- Create a new migration to modify an existing schema.
- Never run destructive database operations without explicit approval.
- Never reset or drop a database containing data without explicit approval.
- Keep migrations backward-compatible (add first, remove later) so deploys need no downtime.
- Verify migration status before applying potentially risky changes.

## Git Safety
- No destructive Git commands, force-push or history rewrites without explicit approval.
- Check `git status` before modifying or committing files, and never discard uncommitted user changes.