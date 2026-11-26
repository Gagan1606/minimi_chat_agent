const form = document.querySelector("#composer"),
  prompt = document.querySelector("#prompt"),
  messages = document.querySelector("#messages"),
  status = document.querySelector("#status"),
  workspace = document.querySelector("#workspace-id");
let csrf = "";
function add(role, text, createdAt) {
  const li = document.createElement("li");
  li.className = "message";
  li.append(document.createTextNode(text));
  if (createdAt) {
    const time = document.createElement("time");
    time.dateTime = createdAt;
    time.textContent = new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(createdAt));
    li.append(time);
  }
  messages.append(li);
}
async function init() {
  try {
    const r = await fetch("/auth/session", { credentials: "same-origin" });
    if (!r.ok) throw Error();
    csrf = (await r.json()).csrfToken;
  } catch {
    status.textContent = "Sign in to use workspace chat.";
  }
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = workspace.value.trim(),
    text = prompt.value.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !text) {
    status.textContent = "Enter a valid workspace ID and message.";
    return;
  }
  status.textContent = "Sending…";
  try {
    const r = await fetch(`/api/v1/workspaces/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ scope: "workspace", message: text }),
    });
    const b = await r.json();
    if (!r.ok) throw Error();
    add("You", text);
    add("Momos", b.answer, b.createdAt);
    prompt.value = "";
    status.textContent = "";
  } catch {
    status.textContent =
      "Could not send the message. Check workspace access and try again.";
  }
});
void init();
