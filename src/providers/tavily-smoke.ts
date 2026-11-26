import "dotenv/config";
import { createTavilyWebSearch } from "./tavily.js";

try {
  const search = createTavilyWebSearch(process.env);
  const results = await search.search("Momos provider setup smoke test", 1);
  console.log(
    `Tavily: OK (${results.length} result${results.length === 1 ? "" : "s"})`,
  );
} catch (error) {
  const providerError =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown })
      : {};
  const status =
    typeof providerError.status === "number"
      ? `HTTP ${providerError.status}`
      : undefined;
  const code =
    typeof providerError.code === "string" &&
    /^[A-Z0-9_-]{1,40}$/i.test(providerError.code)
      ? providerError.code
      : undefined;
  console.error(
    `Tavily: failed (${[status, code].filter(Boolean).join(" ") || "request error"})`,
  );
  process.exitCode = 1;
}
