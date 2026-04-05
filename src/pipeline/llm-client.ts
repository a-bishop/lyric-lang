import { createOpenAI } from "@ai-sdk/openai";

export const GROQ_MODEL = "openai/gpt-oss-20b";

export function createGroqClient(apiKey: string) {
  return createOpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
}
