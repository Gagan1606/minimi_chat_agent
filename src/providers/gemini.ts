import { GoogleGenAI } from "@google/genai";
import type { ModelProvider } from "./types.js";

export interface GeminiEnvironment {
  MODEL_NAME?: string;
  MODEL_API_KEY?: string;
  MODEL_TIMEOUT_MS?: string;
}

export interface GeminiClientLike {
  models: {
    generateContent(input: {
      model: string;
      contents: string;
      config?: { systemInstruction?: string };
    }): Promise<{ text?: string }>;
  };
}

export function createGeminiModel(
  environment: GeminiEnvironment,
  injectedClient?: GeminiClientLike,
): ModelProvider {
  const modelName = environment.MODEL_NAME?.trim();
  const apiKey = environment.MODEL_API_KEY?.trim();
  const configuredTimeout = Number(environment.MODEL_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 5_000;
  if (!modelName) throw new Error("MODEL_NAME is required");
  if (!apiKey && !injectedClient) throw new Error("MODEL_API_KEY is required");

  const client =
    injectedClient ??
    (new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
    }) as unknown as GeminiClientLike);

  return {
    async generate(prompt, systemInstruction) {
      if (!prompt.trim()) throw new Error("Prompt must not be empty");
      const response = await client.models.generateContent({
        model: modelName,
        contents: prompt,
        ...(systemInstruction ? { config: { systemInstruction } } : {}),
      });
      const text = response.text?.trim();
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    },
  };
}
