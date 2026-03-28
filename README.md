# lyric-lang

A Cloudflare Workers API that extracts language learning content from song lyrics.

## What it does

Given a song's lyrics, source language, and target language, it:
1. **Extracts** vocabulary (slang, idioms, colloquial terms), grammar patterns, and cultural notes
2. **Generates** a structured learning plan with exercises and spaced review schedules

## API

### Endpoints

**POST /ingest**
- Creates a new extraction job
- Auth: `Authorization: Bearer <API_KEY>`
- Body:
```json
{
  "title": "La Bamba",
  "artist": "Ritchie Valens",
  "sourceLanguage": "es",
  "targetLanguage": "en",
  "lyrics": "Para bailar la bamba..."
}
```
- Returns: `{ "jobId": "...", "status": "pending" }`

**GET /jobs/:id**
- Check job status and get results
- Auth: `Authorization: Bearer <API_KEY>`
- Returns job status or completed results with concepts + plan

### Health

**GET /health** - Returns `{ "status": "ok" }`

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Database:** D1 (SQLite)
- **LLM:** Groq (openai/gpt-oss-20b)
- **Framework:** Hono + Drizzle ORM + AI SDK

## Development

```bash
# Install dependencies
npm install

# Deploy to Cloudflare
npx wrangler deploy

# Add secrets
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put API_KEY
```

## TODOs / Future Work

- [ ] Cloudflare Queue for async processing (when 3+ LLM calls needed)
- [ ] Audio input via Whisper transcription
- [ ] Knowledge graph / prerequisite tracking ("don't re-teach subjunctive")
- [ ] Multi-tenant support with D1 isolation
- [ ] FSRS spaced repetition algorithm (replace hardcoded intervals)
- [ ] Eval harness (run prompt versions against golden dataset)
- [ ] Web UI (Hono serves static, or separate Pages project)
