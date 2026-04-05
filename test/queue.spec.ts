import { env, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the pipeline to prevent real LLM calls
vi.mock('../src/pipeline/extract', () => ({
	extractConcepts: vi.fn().mockResolvedValue({
		concepts: {
			level: 'B1',
			vocabulary: [{ term: 'bailar', type: 'standard', register: 'informal', definition: 'to dance', exampleLine: 'Para bailar', difficulty: 1 }],
			grammarPatterns: [{ pattern: 'para + infinitive', explanation: 'purpose clause', exampleLine: 'Para bailar la bamba' }],
			culturalNotes: ['Traditional Mexican folk song'],
		},
		log: {
			promptVersion: 'extract-v1',
			modelId: 'openai/gpt-oss-20b',
			inputTokens: 100,
			outputTokens: 200,
			durationMs: 500,
			rawRequest: '{}',
			rawResponse: '{}',
		},
	}),
}));

vi.mock('../src/pipeline/plan', () => ({
	generatePlan: vi.fn().mockResolvedValue({
		plan: {
			summary: 'Learn core vocabulary',
			estimatedHours: 1.5,
			units: [{ order: 1, title: 'Core Vocab', focusType: 'vocabulary', items: ['bailar'], exercises: [{ type: 'gap-fill', prompt: 'Para ___ la bamba', answer: 'bailar', hint: 'to dance' }], reviewSchedule: { initialReviewDays: 1, intervals: [3, 7] } }],
		},
		log: {
			promptVersion: 'plan-v1',
			modelId: 'openai/gpt-oss-20b',
			inputTokens: 200,
			outputTokens: 300,
			durationMs: 800,
			rawRequest: '{}',
			rawResponse: '{}',
		},
	}),
}));

import worker from '../src/index';

async function applyMigrations(db: D1Database) {
	await db.exec(`CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY NOT NULL, status text DEFAULT 'pending' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, error_message text, retry_count integer DEFAULT 0 NOT NULL)`);
	await db.exec(`CREATE TABLE IF NOT EXISTS song_inputs (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, title text NOT NULL, artist text NOT NULL, source_language text NOT NULL, target_language text NOT NULL, lyrics text NOT NULL, genre text, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS extracted_concepts (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, prompt_version text NOT NULL, data text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS learning_plans (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, prompt_version text NOT NULL, data text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS llm_logs (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, stage text NOT NULL, prompt_version text NOT NULL, model_id text NOT NULL, input_tokens integer, output_tokens integer, duration_ms integer, raw_request text NOT NULL, raw_response text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
}

interface QueueMessage {
	jobId: string;
	input: {
		title: string;
		artist: string;
		sourceLanguage: string;
		targetLanguage: string;
		lyrics: string;
		genre?: string;
	};
}

describe('Queue consumer', () => {
	beforeEach(async () => {
		await applyMigrations(env.DB);
	});

	it('processes a job message and marks it complete', async () => {
		const jobId = 'queue-test-1';
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'pending', now, now, 0).run();

		const input = {
			title: 'La Bamba',
			artist: 'Ritchie Valens',
			sourceLanguage: 'es',
			targetLanguage: 'en',
			lyrics: 'Para bailar la bamba se necesita una poca de gracia',
		};

		const batch = createMessageBatch<QueueMessage>('lyric-jobs', [
			{ id: 'msg-1', timestamp: new Date(), attempts: 1, body: { jobId, input } },
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);

		expect(result.outcome).toBe('ok');
		expect(result.explicitAcks).toContain('msg-1');

		// Verify the job is now complete
		const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
		expect(job).toBeTruthy();
		expect(job!.status).toBe('complete');

		// Verify extracted concepts were stored
		const concepts = await env.DB.prepare('SELECT * FROM extracted_concepts WHERE job_id = ?').bind(jobId).first();
		expect(concepts).toBeTruthy();
		expect(concepts!.prompt_version).toBe('extract-v1');

		// Verify learning plan was stored
		const plan = await env.DB.prepare('SELECT * FROM learning_plans WHERE job_id = ?').bind(jobId).first();
		expect(plan).toBeTruthy();
		expect(plan!.prompt_version).toBe('plan-v1');

		// Verify LLM logs for both stages
		const logs = await env.DB.prepare('SELECT * FROM llm_logs WHERE job_id = ? ORDER BY stage').bind(jobId).all();
		expect(logs.results).toHaveLength(2);
		expect(logs.results[0].stage).toBe('extract');
		expect(logs.results[1].stage).toBe('plan');
	});

	it('sets job status to processing during execution', async () => {
		const { extractConcepts } = await import('../src/pipeline/extract');
		const mockedExtract = vi.mocked(extractConcepts);

		const jobId = 'queue-test-status';
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'pending', now, now, 0).run();

		let statusDuringProcessing: string | null = null;
		mockedExtract.mockImplementationOnce(async () => {
			const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(jobId).first();
			statusDuringProcessing = job!.status as string;
			return {
				concepts: {
					level: 'A1' as const,
					vocabulary: [],
					grammarPatterns: [],
					culturalNotes: [],
				},
				log: {
					promptVersion: 'extract-v1', modelId: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, rawRequest: '{}', rawResponse: '{}',
				},
			};
		});

		const batch = createMessageBatch<QueueMessage>('lyric-jobs', [
			{
				id: 'msg-status',
				timestamp: new Date(),
				attempts: 1,
				body: {
					jobId,
					input: { title: 'Test', artist: 'Test', sourceLanguage: 'es', targetLanguage: 'en', lyrics: 'hola mundo' },
				},
			},
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		await getQueueResult(batch, ctx);

		expect(statusDuringProcessing).toBe('processing');
	});

	it('retries the message on failure', async () => {
		const { extractConcepts } = await import('../src/pipeline/extract');
		const mockedExtract = vi.mocked(extractConcepts);
		mockedExtract.mockRejectedValueOnce(new Error('LLM timeout'));

		const jobId = 'queue-test-retry';
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'pending', now, now, 0).run();

		const batch = createMessageBatch<QueueMessage>('lyric-jobs', [
			{
				id: 'msg-retry',
				timestamp: new Date(),
				attempts: 1,
				body: {
					jobId,
					input: { title: 'Test', artist: 'Test', sourceLanguage: 'es', targetLanguage: 'en', lyrics: 'hola mundo' },
				},
			},
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);

		// Individual message should be retried
		expect((result as any).retryMessages).toContainEqual({ msgId: 'msg-retry' });

		// Job should have incremented retry count
		const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
		expect(job!.retry_count).toBe(1);
		expect(job!.status).toBe('pending');
	});

	it('marks job as failed after max retries', async () => {
		const { extractConcepts } = await import('../src/pipeline/extract');
		const mockedExtract = vi.mocked(extractConcepts);
		mockedExtract.mockRejectedValueOnce(new Error('LLM timeout'));

		const jobId = 'queue-test-maxretry';
		const now = Math.floor(Date.now() / 1000);
		// Already at retry count 3 (max)
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'pending', now, now, 3).run();

		const batch = createMessageBatch<QueueMessage>('lyric-jobs', [
			{
				id: 'msg-maxretry',
				timestamp: new Date(),
				attempts: 4,
				body: {
					jobId,
					input: { title: 'Test', artist: 'Test', sourceLanguage: 'es', targetLanguage: 'en', lyrics: 'hola mundo' },
				},
			},
		]);
		const ctx = createExecutionContext();
		await worker.queue(batch, env, ctx);
		const result = await getQueueResult(batch, ctx);

		// Message should be acked (not retried) — we've given up
		const msgResult = result.explicitAcks;
		expect(msgResult).toContain('msg-maxretry');

		// Job should be failed
		const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
		expect(job!.status).toBe('failed');
		expect(job!.error_message).toContain('LLM timeout');
	});
});
