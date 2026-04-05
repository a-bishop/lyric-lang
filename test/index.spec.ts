import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const AUTH_HEADER = { Authorization: 'Bearer test-api-key' };

const VALID_BODY = {
	title: 'La Bamba',
	artist: 'Ritchie Valens',
	sourceLanguage: 'es',
	targetLanguage: 'en',
	lyrics: 'Para bailar la bamba se necesita una poca de gracia',
};

async function applyMigrations(db: D1Database) {
	await db.exec(`CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY NOT NULL, status text DEFAULT 'pending' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, error_message text, retry_count integer DEFAULT 0 NOT NULL)`);
	await db.exec(`CREATE TABLE IF NOT EXISTS song_inputs (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, title text NOT NULL, artist text NOT NULL, source_language text NOT NULL, target_language text NOT NULL, lyrics text NOT NULL, genre text, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS extracted_concepts (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, prompt_version text NOT NULL, data text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS learning_plans (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, prompt_version text NOT NULL, data text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
	await db.exec(`CREATE TABLE IF NOT EXISTS llm_logs (id text PRIMARY KEY NOT NULL, job_id text NOT NULL, stage text NOT NULL, prompt_version text NOT NULL, model_id text NOT NULL, input_tokens integer, output_tokens integer, duration_ms integer, raw_request text NOT NULL, raw_response text NOT NULL, created_at integer NOT NULL, FOREIGN KEY (job_id) REFERENCES jobs(id))`);
}

async function fetchWorker(path: string, init?: RequestInit) {
	const request = new IncomingRequest(`http://localhost${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	// Don't await waitUntil — the background processJob will fail without a real LLM
	// We only care about the HTTP response layer in these tests
	return response;
}

describe('GET /health', () => {
	it('returns 200 with ok status', async () => {
		const res = await fetchWorker('/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});
});

describe('POST /ingest', () => {
	beforeEach(async () => {
		await applyMigrations(env.DB);
	});

	it('returns 401 without auth header', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe('Unauthorized');
	});

	it('returns 401 with wrong token', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { ...AUTH_HEADER, Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});

	it('returns 400 for invalid JSON', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: 'not json',
			headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe('Invalid JSON body');
	});

	it('returns 400 when required fields are missing', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: JSON.stringify({ title: 'Test' }),
			headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toContain('required');
	});

	it('returns 202 with jobId for valid request', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(202);
		const body = await res.json<{ jobId: string; status: string }>();
		expect(body.jobId).toBeDefined();
		expect(typeof body.jobId).toBe('string');
		expect(body.status).toBe('pending');
	});

	it('creates job and song_input records in D1', async () => {
		const res = await fetchWorker('/ingest', {
			method: 'POST',
			body: JSON.stringify(VALID_BODY),
			headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
		});
		const { jobId } = await res.json<{ jobId: string }>();

		const jobResult = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
		expect(jobResult).toBeTruthy();
		expect(jobResult!.status).toBe('pending');
		expect(jobResult!.retry_count).toBe(0);

		const inputResult = await env.DB.prepare('SELECT * FROM song_inputs WHERE job_id = ?').bind(jobId).first();
		expect(inputResult).toBeTruthy();
		expect(inputResult!.title).toBe('La Bamba');
		expect(inputResult!.artist).toBe('Ritchie Valens');
		expect(inputResult!.source_language).toBe('es');
	});
});

describe('GET /jobs/:id', () => {
	beforeEach(async () => {
		await applyMigrations(env.DB);
	});

	it('returns 401 without auth', async () => {
		const res = await fetchWorker('/jobs/nonexistent');
		expect(res.status).toBe(401);
	});

	it('returns 404 for non-existent job', async () => {
		const res = await fetchWorker('/jobs/nonexistent', {
			headers: AUTH_HEADER,
		});
		expect(res.status).toBe(404);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe('Not found');
	});

	it('returns pending status for in-progress job', async () => {
		// Insert a job directly into D1
		const jobId = 'test-job-1';
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'processing', now, now, 0).run();

		const res = await fetchWorker(`/jobs/${jobId}`, { headers: AUTH_HEADER });
		expect(res.status).toBe(200);
		const body = await res.json<{ jobId: string; status: string }>();
		expect(body.jobId).toBe(jobId);
		expect(body.status).toBe('processing');
	});

	it('returns complete job with concepts and plan', async () => {
		const jobId = 'test-job-complete';
		const now = Math.floor(Date.now() / 1000);

		const mockConcepts = {
			level: 'B1',
			vocabulary: [{ term: 'bailar', type: 'standard', register: 'informal', definition: 'to dance', exampleLine: 'Para bailar', difficulty: 1 }],
			grammarPatterns: [],
			culturalNotes: ['La Bamba is a traditional Mexican folk song'],
		};

		const mockPlan = {
			summary: 'Learn core vocabulary from La Bamba',
			estimatedHours: 1.5,
			units: [{ order: 1, title: 'Core Vocab', focusType: 'vocabulary', items: ['bailar'], exercises: [], reviewSchedule: { initialReviewDays: 1, intervals: [3, 7] } }],
		};

		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, retry_count) VALUES (?, ?, ?, ?, ?)'
		).bind(jobId, 'complete', now, now, 0).run();

		await env.DB.prepare(
			'INSERT INTO extracted_concepts (id, job_id, prompt_version, data, created_at) VALUES (?, ?, ?, ?, ?)'
		).bind('ec-1', jobId, 'extract-v1', JSON.stringify(mockConcepts), now).run();

		await env.DB.prepare(
			'INSERT INTO learning_plans (id, job_id, prompt_version, data, created_at) VALUES (?, ?, ?, ?, ?)'
		).bind('lp-1', jobId, 'plan-v1', JSON.stringify(mockPlan), now).run();

		const res = await fetchWorker(`/jobs/${jobId}`, { headers: AUTH_HEADER });
		expect(res.status).toBe(200);
		const body = await res.json<{ jobId: string; status: string; concepts: typeof mockConcepts; plan: typeof mockPlan }>();
		expect(body.status).toBe('complete');
		expect(body.concepts.level).toBe('B1');
		expect(body.concepts.vocabulary).toHaveLength(1);
		expect(body.concepts.vocabulary[0].term).toBe('bailar');
		expect(body.plan.summary).toContain('La Bamba');
		expect(body.plan.units).toHaveLength(1);
	});

	it('returns failed job with error message', async () => {
		const jobId = 'test-job-failed';
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			'INSERT INTO jobs (id, status, created_at, updated_at, error_message, retry_count) VALUES (?, ?, ?, ?, ?, ?)'
		).bind(jobId, 'failed', now, now, 'LLM timeout', 3).run();

		const res = await fetchWorker(`/jobs/${jobId}`, { headers: AUTH_HEADER });
		expect(res.status).toBe(200);
		const body = await res.json<{ jobId: string; status: string; errorMessage: string; retryCount: number }>();
		expect(body.status).toBe('failed');
		expect(body.errorMessage).toBe('LLM timeout');
		expect(body.retryCount).toBe(3);
	});
});
