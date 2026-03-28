import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { jobs, songInputs, extractedConcepts, learningPlans, llmLogs } from "./db/schema";
import { extractConcepts } from "./pipeline/extract";
import { generatePlan } from "./pipeline/plan";
import type { Env, SongInput } from "./types";
import { createLogger } from "./logger";

interface JobEnv extends Env {
  executionCtx: ExecutionContext;
}

const app = new Hono<{ Bindings: JobEnv }>();

function requireAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }) {
  const authHeader = c.req.header("Authorization");
  const expectedToken = `Bearer ${c.env.API_KEY}`;
  
  if (!authHeader || authHeader !== expectedToken) {
    return false;
  }
  return true;
}

async function processJob(jobId: string, input: SongInput, env: Env) {
  const db = drizzle(env.DB);
  const logger = createLogger(jobId);
  const now = new Date();

  try {
    logger.info("Starting job processing");

    await db.update(jobs).set({ status: "processing", updatedAt: now }).where(eq(jobs.id, jobId));

    const { concepts, log: extractLog } = await extractConcepts(input, env, jobId);

    await db.insert(extractedConcepts).values({
      id: nanoid(),
      jobId,
      promptVersion: extractLog.promptVersion,
      data: JSON.stringify(concepts),
      createdAt: new Date(),
    });

    await db.insert(llmLogs).values({
      id: nanoid(),
      jobId,
      stage: "extract",
      promptVersion: extractLog.promptVersion,
      modelId: extractLog.modelId,
      inputTokens: extractLog.inputTokens,
      outputTokens: extractLog.outputTokens,
      durationMs: extractLog.durationMs,
      rawRequest: extractLog.rawRequest,
      rawResponse: extractLog.rawResponse,
      createdAt: new Date(),
    });

    const { plan, log: planLog } = await generatePlan(input, concepts, env, jobId);

    await db.insert(learningPlans).values({
      id: nanoid(),
      jobId,
      promptVersion: planLog.promptVersion,
      data: JSON.stringify(plan),
      createdAt: new Date(),
    });

    await db.insert(llmLogs).values({
      id: nanoid(),
      jobId,
      stage: "plan",
      promptVersion: planLog.promptVersion,
      modelId: planLog.modelId,
      inputTokens: planLog.inputTokens,
      outputTokens: planLog.outputTokens,
      durationMs: planLog.durationMs,
      rawRequest: planLog.rawRequest,
      rawResponse: planLog.rawResponse,
      createdAt: new Date(),
    });

    await db.update(jobs).set({ status: "complete", updatedAt: new Date() }).where(eq(jobs.id, jobId));

    logger.info("Job completed successfully");
  } catch (error) {
    logger.error("Job processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    const currentRetryCount = job?.retryCount ?? 0;

    if (currentRetryCount < 3) {
      logger.info(`Scheduling retry ${currentRetryCount + 1}/3`);
      await db
        .update(jobs)
        .set({
          status: "pending",
          retryCount: currentRetryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      const delayMs = 5000 * (currentRetryCount + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      await processJob(jobId, input, env);
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    }
  }
}

app.post("/ingest", async (c) => {
  if (!requireAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = drizzle(c.env.DB);
  const jobId = nanoid();
  const now = new Date();

  let input: SongInput;
  try {
    input = await c.req.json<SongInput>();
    if (!input.lyrics || !input.sourceLanguage || !input.targetLanguage) {
      return c.json({ error: "lyrics, sourceLanguage, targetLanguage are required" }, 400);
    }
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  await db.insert(jobs).values({
    id: jobId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
  });

  await db.insert(songInputs).values({
    id: nanoid(),
    jobId,
    title: input.title ?? "Unknown",
    artist: input.artist ?? "Unknown",
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    lyrics: input.lyrics,
    genre: input.genre ?? null,
    createdAt: now,
  });

  c.executionCtx.waitUntil(processJob(jobId, input, c.env));

  return c.json({ jobId, status: "pending" }, 202);
});

app.get("/jobs/:id", async (c) => {
  if (!requireAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = drizzle(c.env.DB);
  const jobId = c.req.param("id");

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return c.json({ error: "Not found" }, 404);

  if (job.status !== "complete") {
    return c.json({
      jobId,
      status: job.status,
      errorMessage: job.errorMessage,
      retryCount: job.retryCount,
    });
  }

  const [plan] = await db.select().from(learningPlans).where(eq(learningPlans.jobId, jobId));
  const [concepts] = await db.select().from(extractedConcepts).where(eq(extractedConcepts.jobId, jobId));

  return c.json({
    jobId,
    status: job.status,
    concepts: JSON.parse(concepts.data),
    plan: JSON.parse(plan.data),
  });
});

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
