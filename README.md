# Momos

Momos is a TypeScript/Node.js service for private and workspace chat. This
walking skeleton provides PostgreSQL persistence, OIDC sign-in, session/CSRF
handling, and health checks. Product chat routes are added in later milestones.

## Local development

1. Copy `.env.example` to `.env`. The listed OIDC and database values are dummy
   local-development credentials. Do not use them outside a local machine.
2. Start PostgreSQL and the local Keycloak realm with `docker compose up -d`.
3. Run `npm ci` and `npm run db:migrate`.
4. Start the service with `npm run dev`.
5. Check `http://localhost:3000/health/live` and
   `http://localhost:3000/health/ready`.
6. Start sign-in at `http://localhost:3000/auth/oidc/start`. The seeded local
   Platform Admin must configure TOTP when Keycloak prompts for it.

To stop the local services, run `docker compose stop`. The named PostgreSQL
volume is retained between starts; do not remove it if it contains data you
need.

## Checks

- `npm test` runs unit tests and real-PostgreSQL integration tests. Start the
  local PostgreSQL container first.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and
  `npm run build` run the project quality gates.
- `npm run db:migrate` applies pending SQL migrations with a PostgreSQL advisory
  lock. Applied migration files are immutable.

Production deployments must supply real OIDC and PostgreSQL settings through a
secret manager, use HTTPS, set `SESSION_COOKIE_SECURE=true`, and run migrations
as a deployment step before starting the service.
