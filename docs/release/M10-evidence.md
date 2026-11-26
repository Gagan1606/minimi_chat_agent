# M10 release evidence

This report is intentionally a checklist until it is executed against the selected staging service. A blank or `BLOCKED` item is not a pass.

| Gate         | Target/evidence                                                                | State                                                     |
| ------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| CI quality   | Tests, lint, types, format, build, Docker                                      | Run on M10 PR                                             |
| Evaluation   | `eval/scenarios.json`; sanitized report and human review                       | BLOCKED: staging host and credentials not configured here |
| Chat load    | 10 RPS sustained; 20 RPS / 30 sec; 100 in-flight; chat p95 ≤10 sec             | BLOCKED: staging users/provider budget required           |
| Security     | Tenant/privacy regressions, TLS/cookie/MFA review, dependency and secret scans | CI tests available; deployed config review pending        |
| Backup       | Encrypted daily backup, 30-day retention, restore exercise                     | BLOCKED: provider selection/console access required       |
| Recovery     | RPO ≤24 hours, RTO ≤8 hours, measured restore report                           | BLOCKED: staging recovery exercise required               |
| Availability | 99.5% target, actionable alert routing and runbook                             | BLOCKED: deployment metrics/alert service required        |
| Rollback     | Staging release and rollback rehearsal                                         | BLOCKED: deployment pipeline/target required              |

No accuracy SLA is declared because the requirements do not define a scored rubric or reference dataset. Evaluation records scenario, expected behavior, observed answer, citations, duration, and human rationale.
