const companyId = new URLSearchParams(location.search).get("companyId");
const status = document.querySelector("#company-admin-status");

async function send(path, method, body) {
  const session = await fetch("/auth/session", { credentials: "same-origin" });
  const sessionData = await session.json();
  if (!session.ok) throw new Error("Sign in to manage this company.");
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": sessionData.csrfToken,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Request failed");
  return data;
}

function onSubmit(formId, action) {
  document.querySelector(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      status.textContent = await action(new FormData(event.currentTarget));
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "Request failed";
    }
  });
}

onSubmit("#workspace-create", async (form) => {
  const result = await send(
    `/api/v1/companies/${companyId}/workspaces`,
    "POST",
    {
      name: form.get("name"),
    },
  );
  return `Workspace created: ${result.id}`;
});
onSubmit("#member-add", async (form) => {
  await send(
    `/api/v1/companies/${companyId}/members`,
    "POST",
    Object.fromEntries(form),
  );
  return "Member added.";
});
onSubmit("#workspace-admin-assign", async (form) => {
  const data = Object.fromEntries(form);
  const workspaceId = data.workspaceId;
  delete data.workspaceId;
  await send(`/api/v1/workspaces/${workspaceId}/workspace-admin`, "PUT", data);
  return "Workspace Admin assigned.";
});
onSubmit("#company-admin-assign", async (form) => {
  await send(`/api/v1/companies/${companyId}/company-admin`, "PUT", {
    personId: form.get("personId"),
  });
  return "Company Admin assigned.";
});
