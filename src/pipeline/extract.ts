import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { PROMPT_VERSIONS, EXTRACT_SYSTEM_PROMPT } from "./prompts";
import type { SongInput, ExtractedConcepts, Env, VocabItem, GrammarPattern } from "../types";
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
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("429") || message.includes("rate")) return true;
    if (message.includes("500") || message.includes("502") || message.includes("503")) return true;
    if (message.includes("timeout") || message.includes("timed out")) return true;
    if (message.includes("internal") && message.includes("error")) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(baseMs: number): number {
  return baseMs + Math.random() * baseMs * 0.5;
}

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
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL;

  const userPrompt = `Song: "${song.title}" by ${song.artist}${song.genre ? ` (${song.genre})` : ""}
Source language: ${song.sourceLanguage}
Target language: ${song.targetLanguage}

Lyrics:
${song.lyrics}

Extract vocabulary (prioritizing slang, idioms, and colloquial terms), grammar patterns, cultural notes, and estimate the CEFR level.`;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
      const delayMs = randomJitter(backoffMs);
      logger.info(`Retry attempt ${attempt} after ${Math.round(delayMs)}ms backoff`, { attempt });
      await sleep(delayMs);
    }

    try {
      const start = Date.now();

      const result = await generateObject({
        model: anthropic(model),
        schema: ExtractedConceptsSchema,
        system: EXTRACT_SYSTEM_PROMPT,
        prompt: userPrompt,
      });

      const durationMs = Date.now() - start;
      const concepts = result.object;

      const validation = validateExtractedConcepts(concepts, song.lyrics, logger);
      if (!validation.valid) {
        logger.warn("Validation failed, retrying", { errors: validation.errors, attempt });
        lastError = new Error(`Validation failed: ${validation.errors.join("; ")}`);
        continue;
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
    } catch (error) {
      lastError = error;
      const isRetryable = isRetryableError(error);
      logger.error(`Extraction attempt ${attempt + 1} failed`, {
        error: error instanceof Error ? error.message : String(error),
        retryable: isRetryable,
      });

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw error;
      }
    }
  }

  throw lastError;
}
