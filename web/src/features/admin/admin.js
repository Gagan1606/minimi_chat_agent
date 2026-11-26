const overview = document.querySelector("#overview");
const events = document.querySelector("#events");
const status = document.querySelector("#status");

async function getJson(path) {
  const response = await fetch(path, { credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? "Request failed");
  return body;
}

try {
  const data = await getJson("/api/v1/admin/overview");
  overview.textContent = JSON.stringify(data, null, 2);
  if (document.body.dataset.view === "platform") {
    const eventPage = await getJson("/api/v1/admin/rate-limit-events?limit=20");
    events.replaceChildren();
    for (const event of eventPage.items) {
      const item = document.createElement("li");
      const time = new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }).format(new Date(event.occurredAt));
      item.textContent = `${time} IST · ${event.rule} · ${event.route} · ${event.requestId}`;
      events.append(item);
    }
    if (!eventPage.items.length) {
      const item = document.createElement("li");
      item.textContent = "No rate-limit events in this page.";
      events.append(item);
    }
  }
} catch (error) {
  status.textContent =
    error instanceof Error
      ? error.message
      : "Unable to load administration data.";
  overview.textContent = "Administration data is unavailable.";
}
