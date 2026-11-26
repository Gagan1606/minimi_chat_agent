const list = document.querySelector("#conversation-list");
const messages = document.querySelector("#messages");
const promptInput = document.querySelector("#prompt");
const composer = document.querySelector("#composer");
const sendButton = document.querySelector("#send");
const status = document.querySelector("#status");
const deleteCurrent = document.querySelector("#delete-current");

let csrfToken = "";
let currentConversationId = null;
let conversations = [];

function setStatus(message) {
  status.textContent = message;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.method && options.method !== "GET")
    headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body?.error?.code;
    if (response.status === 401) setStatus("Sign in to use personal chat.");
    else
      setStatus(
        code === "RATE_LIMITED"
          ? "Too many requests. Please wait a moment."
          : "That request could not be completed. Please try again.",
      );
    throw new Error(code ?? "request_failed");
  }
  return body;
}

async function refreshCsrf() {
  const session = await request("/auth/session");
  csrfToken = session.csrfToken;
}

function showMessage(role, content, createdAt) {
  const item = document.createElement("li");
  item.className = `message ${role}`;
  item.append(document.createTextNode(content));
  if (createdAt) {
    const time = document.createElement("time");
    time.dateTime = createdAt;
    time.textContent = new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(createdAt));
    item.append(time);
  }
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

function renderConversationList() {
  list.replaceChildren();
  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation";
    button.textContent = conversation.title || "New conversation";
    button.setAttribute(
      "aria-current",
      conversation.id === currentConversationId ? "page" : "false",
    );
    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  }
}

async function loadConversations() {
  const result = await request("/api/v1/conversations?scope=personal&limit=50");
  conversations = result.items;
  renderConversationList();
}

async function openConversation(id) {
  try {
    setStatus("Loading conversation…");
    const detail = await request(
      `/api/v1/conversations/${encodeURIComponent(id)}`,
    );
    currentConversationId = detail.id;
    messages.replaceChildren();
    for (const message of detail.messages)
      showMessage(message.role, message.content, message.createdAt);
    deleteCurrent.hidden = false;
    renderConversationList();
    setStatus("");
  } catch {
    // The request helper already shows a safe user-facing error.
  }
}

function startNewConversation() {
  currentConversationId = null;
  messages.replaceChildren();
  deleteCurrent.hidden = true;
  renderConversationList();
  promptInput.focus();
  setStatus("");
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = promptInput.value.trim();
  if (!message || sendButton.disabled) return;
  showMessage("user", message);
  promptInput.value = "";
  sendButton.disabled = true;
  setStatus("Thinking…");
  try {
    const result = await request("/api/v1/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        scope: "personal",
        ...(currentConversationId
          ? { conversationId: currentConversationId }
          : {}),
        message,
      }),
    });
    currentConversationId = result.conversationId;
    showMessage("assistant", result.answer, result.createdAt);
    deleteCurrent.hidden = false;
    await loadConversations();
    setStatus("");
  } catch {
    // Keep the attempted message visible so the user can refer to it and retry.
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
});

document
  .querySelector("#new-chat")
  .addEventListener("click", startNewConversation);

deleteCurrent.addEventListener("click", async () => {
  if (!currentConversationId || !window.confirm("Delete this conversation?"))
    return;
  try {
    await request(
      `/api/v1/conversations/${encodeURIComponent(currentConversationId)}`,
      { method: "DELETE" },
    );
    startNewConversation();
    await loadConversations();
    setStatus("Conversation deleted.");
  } catch {
    // The request helper already shows a safe user-facing error.
  }
});

document
  .querySelector("#delete-history")
  .addEventListener("click", async () => {
    if (
      !window.confirm(
        "Delete all personal chat history? This cannot be undone.",
      )
    )
      return;
    try {
      const result = await request("/api/v1/me/history", { method: "DELETE" });
      startNewConversation();
      conversations = [];
      renderConversationList();
      setStatus(
        `${result.deletedCount} conversation${result.deletedCount === 1 ? "" : "s"} deleted.`,
      );
    } catch {
      // The request helper already shows a safe user-facing error.
    }
  });

try {
  await refreshCsrf();
  await loadConversations();
} catch {
  // Authentication and availability errors are reported in the status region.
}
