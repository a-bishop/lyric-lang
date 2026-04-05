import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { jobs, songInputs, extractedConcepts, learningPlans, llmLogs } from "./db/schema";
import { extractConcepts } from "./pipeline/extract";
import { generatePlan } from "./pipeline/plan";
import type { Env, SongInput, JobMessage } from "./types";
import { createLogger } from "./logger";

const app = new Hono<{ Bindings: Env }>();

function requireAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }) {
  const authHeader = c.req.header("Authorization");
  const expectedToken = `Bearer ${c.env.API_KEY}`;

  if (!authHeader || authHeader !== expectedToken) {
    return false;
  }
  return true;
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

  await c.env.JOB_QUEUE.send({ jobId, input } satisfies JobMessage);

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

const MAX_JOB_RETRIES = 3;

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { jobId, input } = msg.body;
      const db = drizzle(env.DB);
      const logger = createLogger(jobId);

      try {
        logger.info("Processing job from queue");
        await db.update(jobs).set({ status: "processing", updatedAt: new Date() }).where(eq(jobs.id, jobId));

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
        msg.ack();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Job processing failed", { error: errorMessage });

        const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
        const currentRetryCount = (job?.retryCount ?? 0) + 1;

        if (currentRetryCount >= MAX_JOB_RETRIES) {
          await db
            .update(jobs)
            .set({
              status: "failed",
              errorMessage,
              retryCount: currentRetryCount,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, jobId));
          logger.error(`Job failed permanently after ${currentRetryCount} retries`);
          msg.ack();
        } else {
          await db
            .update(jobs)
            .set({
              status: "pending",
              retryCount: currentRetryCount,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, jobId));
          logger.info(`Scheduling retry ${currentRetryCount}/${MAX_JOB_RETRIES}`);
          msg.retry();
        }
      }
    }
  },
};
