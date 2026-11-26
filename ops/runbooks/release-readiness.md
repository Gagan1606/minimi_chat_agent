# Release readiness and incident runbook

## Availability and dependency incident

1. Check `/health/live` and `/health/ready`, then inspect route latency/error and provider/vector dependency metrics. Do not use message content, personal identifiers, or conversation IDs in diagnostics.
2. For PostgreSQL failure, stop writes and use readiness state to remove unhealthy instances. Restore database access before reopening traffic.
3. For vector outage, keep PostgreSQL lexical/date retrieval enabled. Confirm deleted/tombstoned messages remain excluded by PostgreSQL revalidation.
4. For model or web-search outage, return the existing retryable service error; do not present an unverified current answer. Preserve existing sessions and database-backed history where possible.
5. Record incident start/end, impact, status codes, affected dependency, mitigation, and follow-up. Do not include prompts, answers, tokens, or provider secrets.

## Release gates

- Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`, and Docker build on the release commit.
- Run `node eval/run.mjs` only against a disposable HTTPS staging environment with approved test-user credentials. Manually score the evaluation criteria and retain the sanitized report.
- Run `node tests/load/workspace-chat.mjs` with at least 20 staging users. Verify chat p95 ≤10 seconds, 10 RPS sustained, 20 RPS for 30 seconds, and no more than 100 in-flight requests. Keep an eye on provider spend and stop the run if the staging budget is exceeded.
- Follow [deletion-retention.md](../../docs/operations/deletion-retention.md) for encrypted backup verification and restore. Record measured RPO and RTO; required targets are ≤24 hours and ≤8 hours.
- Confirm TLS 1.2+, secure cookies, Platform Admin MFA, role/tenant/privacy regressions, secret scan, dependency audit, alert routing, and rollback rehearsal before release.

## Current evidence boundary

CI proves code-level checks, not staging availability, provider capacity, backup configuration, or restore timing. Fill in the release evidence report only after the selected host/database, model/search credentials, and recovery access are available. Do not mark a release gate passed based on a local mock or a green CI run.
