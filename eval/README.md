# Evaluation harness

`scenarios.json` is a repeatable task set, not a numeric answer-accuracy promise. Run scenarios manually or through the staging API and score the named behavioral checks. Seed each history scenario before sending its follow-up. Use separate personal users and two workspaces for isolation cases. The provider-failure scenario requires a staging fault-injection window and is intentionally not run against production.

For each run, record the scenario ID, expected behavior/checks, observed answer or safe error, citation URLs, elapsed time, and pass/fail rationale. Do not place real personal or company data in the evaluation report. The open-ended checks are reviewed by a human; no automatic factual-accuracy score is claimed.

`node eval/run.mjs` executes the stateless personal cases that do not require seeded history or fault injection. It requires `MOMOS_EVAL_CONFIRM=staging`, `MOMOS_BASE_URL` using HTTPS, `MOMOS_SESSION_COOKIE`, and `MOMOS_CSRF_TOKEN`. It refuses localhost and production-looking URLs. Results are printed as JSON and are not persisted by default.
