import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeminiModel,
  type GeminiClientLike,
} from "../src/providers/gemini.js";
import {
  createTavilyWebSearch,
  type TavilyClientLike,
} from "../src/providers/tavily.js";

test("Gemini adapter sends configured model and maps generated text", async () => {
  let request: unknown;
  const client: GeminiClientLike = {
    models: {
      generateContent: async (input) => {
        request = input;
        return { text: "A concise answer" };
      },
    },
  };
  const model = createGeminiModel(
    { MODEL_NAME: "gemini-test", MODEL_API_KEY: "test-key" },
    client,
  );

  const answer = await model.generate("Question", "Instructions");

  assert.equal(answer, "A concise answer");
  assert.deepEqual(request, {
    model: "gemini-test",
    contents: "Question",
    config: { systemInstruction: "Instructions" },
  });
});

test("Gemini adapter rejects an empty model response", async () => {
  const client: GeminiClientLike = {
    models: { generateContent: async () => ({ text: undefined }) },
  };
  const model = createGeminiModel(
    { MODEL_NAME: "gemini-test", MODEL_API_KEY: "test-key" },
    client,
  );

  await assert.rejects(model.generate("Question"), /empty response/i);
});

test("Tavily adapter maps search results and passes a bounded result count", async () => {
  let request: { query: string; options: Record<string, unknown> } | undefined;
  const client: TavilyClientLike = {
    search: async (query, options) => {
      request = { query, options };
      return {
        results: [
          {
            title: "Source title",
            url: "https://example.com/source",
            content: "Relevant passage",
            score: 0.9,
          },
        ],
      };
    },
  };
  const search = createTavilyWebSearch(
    { WEB_SEARCH_API_KEY: "test-key", WEB_SEARCH_TIMEOUT_MS: "4000" },
    client,
  );

  const results = await search.search("search terms", 3);

  assert.deepEqual(request, {
    query: "search terms",
    options: {
      maxResults: 3,
      searchDepth: "basic",
      topic: "general",
      timeout: 4000,
    },
  });
  assert.deepEqual(results, [
    {
      title: "Source title",
      url: "https://example.com/source",
      content: "Relevant passage",
      score: 0.9,
    },
  ]);
});

test("Tavily adapter clamps invalid result counts and removes malformed results", async () => {
  let maxResults: number | undefined;
  const client: TavilyClientLike = {
    search: async (_query, options) => {
      maxResults = options.maxResults;
      return {
        results: [
          { title: "", url: "javascript:alert(1)", content: "bad" },
          { title: "Valid", url: "https://example.com", content: "ok" },
        ],
      };
    },
  };
  const search = createTavilyWebSearch(
    { WEB_SEARCH_API_KEY: "test-key" },
    client,
  );

  const results = await search.search("query", 1000);

  assert.equal(maxResults, 10);
  assert.deepEqual(results, [
    { title: "Valid", url: "https://example.com/", content: "ok" },
  ]);
});
