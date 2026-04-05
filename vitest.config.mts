import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
				miniflare: {
					bindings: {
						API_KEY: 'test-api-key',
						GROQ_API_KEY: 'test-groq-key',
					},
					d1Databases: {
						DB: {
							id: 'test-db',
						},
					},
					queues: {
						'lyric-jobs': {},
					},
				},
			},
		},
	},
});
