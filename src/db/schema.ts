import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  status: text("status", {
    enum: ["pending", "processing", "complete", "failed"],
  })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
});

export const songInputs = sqliteTable("song_inputs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  sourceLanguage: text("source_language").notNull(),
  targetLanguage: text("target_language").notNull(),
  lyrics: text("lyrics").notNull(),
  genre: text("genre"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const extractedConcepts = sqliteTable("extracted_concepts", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  promptVersion: text("prompt_version").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const learningPlans = sqliteTable("learning_plans", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  promptVersion: text("prompt_version").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const llmLogs = sqliteTable("llm_logs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  stage: text("stage").notNull(),
  promptVersion: text("prompt_version").notNull(),
  modelId: text("model_id").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  durationMs: integer("duration_ms"),
  rawRequest: text("raw_request").notNull(),
  rawResponse: text("raw_response").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
