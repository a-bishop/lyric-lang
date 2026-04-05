import { generateObject } from "ai";
import { z } from "zod";
import { PROMPT_VERSIONS, PLAN_SYSTEM_PROMPT } from "./prompts";
import { createGroqClient, GROQ_MODEL } from "./llm-client";
import { withRetry } from "./retry";
import type { SongInput, ExtractedConcepts, LearningPlan, Env } from "../types";
import { createLogger } from "../logger";

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

const MAX_RETRIES = 3;

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
  const openai = createGroqClient(env.GROQ_API_KEY);
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

  return withRetry(
    async () => {
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
        throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
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
    },
    {
      maxRetries: MAX_RETRIES,
      onRetry: (attempt, error) => {
        logger.warn(`Plan generation retry ${attempt}/${MAX_RETRIES}`, {
          error: error.message,
        });
      },
    },
  );
}
