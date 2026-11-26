import "dotenv/config";
import { createGeminiModel } from "./gemini.js";
import { createTavilyWebSearch } from "./tavily.js";

async function main(): Promise<void> {
  const model = createGeminiModel(process.env);
  const search = createTavilyWebSearch(process.env);

  try {
    await model.generate("Reply with exactly: OK");
    console.log("Gemini: OK");
  } catch (error) {
    console.error(`Gemini: failed (${safeProviderError(error)})`);
    process.exitCode = 1;
    return;
  }

  try {
    const results = await search.search("Momos provider setup smoke test", 1);
    console.log(
      `Tavily: OK (${results.length} result${results.length === 1 ? "" : "s"})`,
    );
  } catch (error) {
    console.error(`Tavily: failed (${safeProviderError(error)})`);
    process.exitCode = 1;
  }
}

function safeProviderError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "request error";
  const providerError = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status =
    typeof providerError.status === "number"
      ? `HTTP ${providerError.status}`
      : undefined;
  const code =
    typeof providerError.code === "string" &&
    /^[A-Z0-9_-]{1,40}$/i.test(providerError.code)
      ? providerError.code
      : undefined;
  let message =
    typeof providerError.message === "string"
      ? providerError.message
      : undefined;
  for (const key of [
    process.env.MODEL_API_KEY,
    process.env.WEB_SEARCH_API_KEY,
  ]) {
    if (key) message = message?.replaceAll(key, "[REDACTED]");
  }
  if (message) {
    message = message
      .replace(/AIza[\w-]{20,}/g, "[REDACTED]")
      .replace(/tvly-[\w-]{8,}/g, "[REDACTED]")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 160);
  }
  return [status, code, message].filter(Boolean).join(" ") || "request error";
}

main().catch(() => {
  console.error("Provider smoke check failed during initialization.");
  process.exitCode = 1;
});
