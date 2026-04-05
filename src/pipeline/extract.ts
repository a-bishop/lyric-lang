import { generateObject } from "ai";
import { z } from "zod";
import { PROMPT_VERSIONS, EXTRACT_SYSTEM_PROMPT } from "./prompts";
import { createGroqClient, GROQ_MODEL } from "./llm-client";
import { withRetry } from "./retry";
import type { SongInput, ExtractedConcepts, Env } from "../types";
import { createLogger } from "../logger";

const VocabItemSchema = z.object({
  term: z.string(),
  type: z.enum(["slang", "idiom", "standard", "colloquial"]),
  register: z.enum(["formal", "informal", "vulgar"]),
  definition: z.string(),
  exampleLine: z.string(),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const GrammarPatternSchema = z.object({
  pattern: z.string(),
  explanation: z.string(),
  exampleLine: z.string(),
});

const ExtractedConceptsSchema = z.object({
  level: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]),
  vocabulary: z.array(VocabItemSchema),
  grammarPatterns: z.array(GrammarPatternSchema),
  culturalNotes: z.array(z.string()),
});

const MAX_RETRIES = 3;

function validateExtractedConcepts(
  concepts: ExtractedConcepts,
  lyrics: string,
  logger: ReturnType<typeof createLogger>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const wordCount = lyrics.split(/\s+/).filter(Boolean).length;

  if (concepts.vocabulary.length === 0 && wordCount > 20) {
    errors.push("No vocabulary extracted from lyrics with significant content");
  }

  if (concepts.grammarPatterns.length === 0 && wordCount > 50) {
    errors.push("No grammar patterns extracted from lyrics with substantial content");
  }

  if (concepts.vocabulary.length > 0) {
    const hasValidExamples = concepts.vocabulary.every(
      (v) => v.exampleLine && v.exampleLine.length > 0
    );
    if (!hasValidExamples) {
      errors.push("Some vocabulary items are missing example lines");
    }
  }

  if (concepts.grammarPatterns.length > 0) {
    const hasValidExamples = concepts.grammarPatterns.every(
      (g) => g.exampleLine && g.exampleLine.length > 0
    );
    if (!hasValidExamples) {
      errors.push("Some grammar patterns are missing example lines");
    }
  }

  const valid = errors.length === 0;
  if (!valid) {
    logger.warn("Post-validation failed", { errors, vocabularyCount: concepts.vocabulary.length });
  }
  return { valid, errors };
}

export interface ExtractionResult {
  concepts: ExtractedConcepts;
  log: {
    promptVersion: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    rawRequest: string;
    rawResponse: string;
  };
}

export async function extractConcepts(
  song: SongInput,
  env: Env,
  jobId?: string
): Promise<ExtractionResult> {
  const logger = createLogger(jobId);
  logger.info("Starting extraction", { hasGroqKey: !!env.GROQ_API_KEY, keyLength: env.GROQ_API_KEY?.length });

  const openai = createGroqClient(env.GROQ_API_KEY);
  const model = GROQ_MODEL;

  const userPrompt = `Song: "${song.title}" by ${song.artist}${song.genre ? ` (${song.genre})` : ""}
Source language: ${song.sourceLanguage}
Target language: ${song.targetLanguage}

Lyrics:
${song.lyrics}

Extract vocabulary (prioritizing slang, idioms, colloquial), grammar patterns, cultural notes. Estimate CEFR level.`;

  return withRetry(
    async () => {
      const start = Date.now();
      logger.info("Calling Groq", { model, promptLength: userPrompt.length });

      const result = await generateObject({
        model: openai(model),
        schema: ExtractedConceptsSchema,
        system: EXTRACT_SYSTEM_PROMPT,
        prompt: userPrompt,
      });

      const durationMs = Date.now() - start;
      const concepts = result.object;

      const validation = validateExtractedConcepts(concepts, song.lyrics, logger);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
      }

      logger.info("Extraction successful", {
        vocabularyCount: concepts.vocabulary.length,
        grammarCount: concepts.grammarPatterns.length,
        level: concepts.level,
      });

      const usage = await result.usage;
      return {
        concepts,
        log: {
          promptVersion: PROMPT_VERSIONS.extract,
          modelId: model,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          durationMs,
          rawRequest: JSON.stringify({ model, system: EXTRACT_SYSTEM_PROMPT, prompt: userPrompt }),
          rawResponse: JSON.stringify(result.response),
        },
      };
    },
    {
      maxRetries: MAX_RETRIES,
      onRetry: (attempt, error) => {
        logger.warn(`Extraction retry ${attempt}/${MAX_RETRIES}`, {
          error: error.message,
        });
      },
    },
  );
}
