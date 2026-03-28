import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { PROMPT_VERSIONS, PLAN_SYSTEM_PROMPT } from "./prompts";
import type { SongInput, ExtractedConcepts, LearningPlan, Env } from "../types";
import { createLogger } from "../logger";

const GROQ_MODEL = "openai/gpt-oss-20b";

const ExerciseSchema = z.object({
  type: z.enum(["gap-fill", "translation", "multiple-choice", "free-write"]),
  prompt: z.string(),
  answer: z.string(),
  hint: z.string(),
});

const ReviewScheduleSchema = z.object({
  initialReviewDays: z.number(),
  intervals: z.array(z.number()),
});

const LearningUnitSchema = z.object({
  order: z.number(),
  title: z.string(),
  focusType: z.enum(["vocabulary", "grammar", "culture", "pronunciation"]),
  items: z.array(z.string()),
  exercises: z.array(ExerciseSchema),
  reviewSchedule: ReviewScheduleSchema,
});

const LearningPlanSchema = z.object({
  summary: z.string(),
  estimatedHours: z.number(),
  units: z.array(LearningUnitSchema),
});

function parseJsonResponse<T>(text: string, schema: z.ZodType<T>): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }
  const parsed = JSON.parse(jsonMatch[0]);
  return schema.parse(parsed);
}

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

function validateLearningPlan(
  plan: LearningPlan,
  concepts: ExtractedConcepts,
  logger: ReturnType<typeof createLogger>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (plan.units.length === 0) {
    errors.push("No learning units generated");
  }

  if (plan.units.length > 0) {
    if (plan.units.length < 3) {
      errors.push("Expected 3-5 learning units");
    }

    const vocabItems = new Set(concepts.vocabulary.map((v) => v.term));
    const grammarItems = new Set(concepts.grammarPatterns.map((g) => g.pattern));
    const allItems = new Set([...vocabItems, ...grammarItems]);

    let coveredItems = new Set<string>();
    for (const unit of plan.units) {
      for (const item of unit.items) {
        if (allItems.has(item)) {
          coveredItems.add(item);
        }
      }
    }

    const coverageRatio = coveredItems.size / allItems.size;
    if (coverageRatio < 0.5 && allItems.size > 5) {
      errors.push(`Low concept coverage: ${Math.round(coverageRatio * 100)}%`);
    }
  }

  for (const unit of plan.units) {
    if (unit.exercises.length === 0) {
      errors.push(`Unit ${unit.order} (${unit.title}) has no exercises`);
    }

    if (unit.exercises.length > 0) {
      const hasHints = unit.exercises.some((e) => e.hint);
      if (!hasHints) {
        logger.debug(`Unit ${unit.order} has no hints in exercises`);
      }
    }

    if (unit.reviewSchedule.initialReviewDays <= 0) {
      errors.push(`Unit ${unit.order} has invalid initial review days`);
    }

    if (unit.reviewSchedule.intervals.length === 0) {
      errors.push(`Unit ${unit.order} has no review intervals`);
    }
  }

  const valid = errors.length === 0;
  if (!valid) {
    logger.warn("Post-validation failed", { errors, unitsCount: plan.units.length });
  }
  return { valid, errors };
}

export interface PlanResult {
  plan: LearningPlan;
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

export async function generatePlan(
  song: SongInput,
  concepts: ExtractedConcepts,
  env: Env,
  jobId?: string
): Promise<PlanResult> {
  const logger = createLogger(jobId);
  const openai = createOpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const model = GROQ_MODEL;

  const userPrompt = `Song: "${song.title}" by ${song.artist}
Source language: ${song.sourceLanguage}
Target language: ${song.targetLanguage}
Estimated level: ${concepts.level}

Extracted concepts:
${JSON.stringify(concepts, null, 2)}

Create a learning plan with 3-5 units. Each unit MUST have these exact fields:
- order: number
- title: string
- focusType: "vocabulary" | "grammar" | "culture" | "pronunciation"
- items: array of strings
- exercises: array with {type, prompt, answer, hint}
- reviewSchedule: {initialReviewDays: number, intervals: array of numbers}`;

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
        model: openai(model),
        schema: LearningPlanSchema,
        system: PLAN_SYSTEM_PROMPT,
        prompt: userPrompt,
      });

      const durationMs = Date.now() - start;
      const plan = result.object;

      const validation = validateLearningPlan(plan, concepts, logger);
      if (!validation.valid) {
        logger.warn("Validation failed, retrying", { errors: validation.errors, attempt });
        lastError = new Error(`Validation failed: ${validation.errors.join("; ")}`);
        continue;
      }

      logger.info("Plan generation successful", {
        unitsCount: plan.units.length,
        estimatedHours: plan.estimatedHours,
      });

      return {
        plan,
        log: {
          promptVersion: PROMPT_VERSIONS.plan,
          modelId: model,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          durationMs,
          rawRequest: JSON.stringify({ model, system: PLAN_SYSTEM_PROMPT, prompt: userPrompt }),
          rawResponse: JSON.stringify(result.response),
        },
      };
    } catch (error) {
      lastError = error;
      const isRetryable = isRetryableError(error);
      logger.error(`Plan generation attempt ${attempt + 1} failed`, {
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
