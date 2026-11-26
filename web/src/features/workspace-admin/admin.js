const workspaceId = new URLSearchParams(location.search).get("workspaceId");
const status = document.querySelector("#workspace-admin-status");

async function send(path, method, body) {
  const session = await fetch("/auth/session", { credentials: "same-origin" });
  const sessionData = await session.json();
  if (!session.ok) throw new Error("Sign in to manage this workspace.");
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": sessionData.csrfToken,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Request failed");
}

for (const [formId, action] of [
  [
    "#member-add",
    async (personId) =>
      send(`/api/v1/workspaces/${workspaceId}/members`, "POST", { personId }),
  ],
  [
    "#member-remove",
    async (personId) =>
      send(
        `/api/v1/workspaces/${workspaceId}/members/${encodeURIComponent(personId)}`,
        "DELETE",
      ),
  ],
]) {
  document.querySelector(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await action(new FormData(event.currentTarget).get("personId"));
      status.textContent = "Member access updated.";
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "Request failed";
    }
  });
}
