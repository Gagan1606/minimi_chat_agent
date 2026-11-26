import { randomUUID } from "node:crypto";

const urlValue = process.env.MOMOS_BASE_URL;
if (!urlValue || process.env.MOMOS_LOAD_CONFIRM !== "staging") {
  throw new Error(
    "Set MOMOS_BASE_URL and MOMOS_LOAD_CONFIRM=staging only for a disposable staging environment",
  );
}
const base = new URL(urlValue);
if (
  base.protocol !== "https:" ||
  /localhost|127\.0\.0\.1|production|(?:^|[-.])prod(?:[-.]|$)/i.test(
    base.hostname,
  )
) {
  throw new Error("Load test only permits an HTTPS non-production host");
}
const workspaceId = process.env.MOMOS_WORKSPACE_ID;
const users = JSON.parse(process.env.MOMOS_LOAD_USERS ?? "[]");
if (
  !workspaceId ||
  !Array.isArray(users) ||
  users.length < 100 ||
  users.some((user) => !user.cookie || !user.csrfToken)
) {
  throw new Error(
    "Provide a workspace ID and at least 100 staging users in MOMOS_LOAD_USERS (JSON cookie/csrfToken pairs)",
  );
}

const cap = 100;
const samples = [];
let inFlight = 0;
let peakInFlight = 0;

async function postChat(index, profile) {
  const user = users[index % users.length];
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  const started = performance.now();
  try {
    const response = await fetch(
      new URL(`/api/v1/workspaces/${workspaceId}/chat`, base),
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          "x-csrf-token": user.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: "workspace",
          message: `M10 load probe ${profile} ${randomUUID()}`,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    await response.arrayBuffer();
    samples.push({
      profile,
      status: response.status,
      ms: performance.now() - started,
    });
  } catch (error) {
    samples.push({
      profile,
      error: error.name,
      ms: performance.now() - started,
    });
  } finally {
    inFlight--;
  }
}

async function runRate(rps, seconds, label) {
  const count = rps * seconds;
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, started + (i * 1000) / rps - performance.now()),
      ),
    );
    if (inFlight >= cap) throw new Error("100 in-flight request cap reached");
    void postChat(i, label);
  }
  while (samples.filter((item) => item.profile === label).length < count)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return summarize(label, count);
}

async function runConcurrency() {
  const label = "100-concurrent";
  await Promise.all(Array.from({ length: 100 }, (_, i) => postChat(i, label)));
  return summarize(label, 100);
}

function summarize(label, count) {
  const items = samples.filter((item) => item.profile === label);
  const durations = items.map((item) => item.ms).sort((a, b) => a - b);
  return {
    label,
    requests: count,
    p95Ms: Math.round(
      durations[
        Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)
      ] ?? 0,
    ),
    non2xxOrNetworkError: items.filter((item) => item.status !== 200).length,
  };
}

const reports = [];
reports.push(await runRate(10, 60, "sustained-10rps"));
reports.push(await runRate(20, 30, "burst-20rps"));
reports.push(await runConcurrency());
process.stdout.write(
  `${JSON.stringify({ baseUrl: base.origin, workspaceId, peakInFlight, inFlightCap: cap, reports }, null, 2)}\n`,
);
