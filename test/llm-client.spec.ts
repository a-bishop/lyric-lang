import { describe, it, expect } from "vitest";
import { createGroqClient, GROQ_MODEL } from "../src/pipeline/llm-client";

describe("GROQ_MODEL", () => {
  it("exports the model identifier", () => {
    expect(GROQ_MODEL).toBe("openai/gpt-oss-20b");
  });
});

describe("createGroqClient", () => {
  it("returns an OpenAI-compatible provider", () => {
    const client = createGroqClient("test-api-key");
    expect(client).toBeDefined();
    expect(typeof client).toBe("function");
  });

  it("creates a callable model instance", () => {
    const client = createGroqClient("test-api-key");
    const model = client(GROQ_MODEL);
    expect(model).toBeDefined();
    expect(model.modelId).toBe(GROQ_MODEL);
  });
});
