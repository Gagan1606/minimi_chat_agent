import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const required = ["MOMOS_BASE_URL", "MOMOS_SESSION_COOKIE", "MOMOS_CSRF_TOKEN"];
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} is required`);
if (process.env.MOMOS_EVAL_CONFIRM !== "staging")
  throw new Error(
    "Set MOMOS_EVAL_CONFIRM=staging to confirm this is a disposable staging environment",
  );
const base = new URL(process.env.MOMOS_BASE_URL);
if (
  base.protocol !== "https:" ||
  /localhost|127\.0\.0\.1|production|(?:^|[-.])prod(?:[-.]|$)/i.test(
    base.hostname,
  )
)
  throw new Error("Evaluation only permits an HTTPS non-production host");
const scenarios = JSON.parse(
  await readFile(new URL("./scenarios.json", import.meta.url), "utf8"),
);
const results = [];
for (const scenario of scenarios.filter(
  (item) =>
    item.scope === "personal" &&
    !item.setup &&
    !item.id.includes("provider-failure"),
)) {
  const started = performance.now();
  const response = await fetch(new URL("/api/v1/chat", base), {
    method: "POST",
    headers: {
      cookie: process.env.MOMOS_SESSION_COOKIE,
      "x-csrf-token": process.env.MOMOS_CSRF_TOKEN,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ scope: "personal", message: scenario.message }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  results.push({
    id: scenario.id,
    expected: scenario.checks,
    status: response.status,
    observed: response.ok ? body.answer : body.error?.code,
    citations: body.citations?.map((item) => item.url) ?? [],
    elapsedMs: Math.round(performance.now() - started),
    humanReviewRequired: true,
  });
}
process.stdout.write(
  `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: base.origin, results }, null, 2)}\n`,
);
