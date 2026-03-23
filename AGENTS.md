# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Local Dev Issues

### workerd binding failure on macOS

**Symptom:** `wrangler dev --local` fails with:
```
*** Fatal uncaught kj::Exception: kj/async-io-unix.c++:945: failed: ::bind(sockfd, &addr.generic, addrlen): Can't assign requested address; toString() = 1.1.1.1:8787
```

**What works:**
- `--ip 0.0.0.0` sometimes helps
- `--remote` to use actual Cloudflare resources
- Deploy directly: `npx wrangler deploy`

**Likely causes:** VPN, firewall, security software (Little Snitch), or macOS network config interfering with workerd's internal loopback communication. The issue is in workerd's internal proxy, not the user code.

**Debugging steps:**
1. `lsof -iTCP:8787` - check if port is bound
2. `nc -zv 127.0.0.1 8787` - verify connectivity
3. Try simple worker (returns "hello") to isolate app issues
4. Try disabling VPN/firewall
5. If all fails: use `--remote` or deploy to test

## AI SDK v5 Notes

- `generateObject` returns a Promise for `usage` - must await: `const usage = await result.usage`
- Token properties are `inputTokens` / `outputTokens` (not `promptTokens`/`completionTokens`)
- Response is accessed via `result.response` (not `result.rawResponse`)
