# moltbank-kb-mcp

Remote [Model Context Protocol](https://modelcontextprotocol.io) server for the
private `moltbankhq/moltbank-kb` knowledge vault. Exposes the vault to
MCP-compatible consumers (Paperclip agents, Mark, Cowork, OpenAI, Claude
connectors, etc.) via a single HTTPS endpoint with bearer-token auth and
per-consumer visibility enforcement.

**Status:** v0.2 adds scoped write tools (`temp_propose_change`) and ops integrations (GA4, Linear). Read path unchanged.

---

## What it does

One Next.js app, four routes:

| Route | Purpose |
| --- | --- |
| `POST /api/mcp` | Streamable-HTTP MCP endpoint. Requires `Authorization: Bearer <token>`. |
| `POST /api/github-webhook` | GitHub push webhook. Verifies HMAC signature and rebuilds the index. |
| `POST /api/admin/refresh` | Manual rebuild, gated by `ADMIN_TOKEN`. |
| `GET  /api/health` | Liveness + last-sync snapshot (no auth). |

The server keeps a shallow clone of `moltbank-kb` on `/tmp`, parses every
markdown file's frontmatter into an in-memory index at cold start, and serves
all tool calls from memory. A GitHub webhook pushes invalidations; a 10-minute
TTL covers the case where the webhook is missed.

### Tools

Every tool takes structured JSON (Zod-validated) and returns structured JSON.
Every tool enforces the caller's scope before it does anything: `max_visibility`
for read tools, `owner` for write tools, `operations.*` for ops tools.
Unavailable tools are not registered for a given caller's `tools/list` response.

**vault_** — read-only, gated by `max_visibility`:

- `vault_search` — ranked full-text search (title > heading > body), filters by section/status.
- `vault_read_file` — read one file by path (path-traversal-safe, visibility-enforced).
- `vault_list_section` — list files in a section with frontmatter metadata.
- `vault_get_status` — coverage snapshot + status summary.
- `vault_search_todos` — all `[!TODO]` markers, filterable by owner/section.
- `vault_list_auto_synced` — `maintained_by: agent` files + staleness flag.
- `vault_get_asset_index` — parsed `wiki/assets/assets-index.md` tables.

**temp_** — write path, gated by `owner` (only four values: `cap|jesus|daniel|marielba`):

- `temp_propose_change` — append a structured proposal to `temp/<owner>.md`. The only file the MCP tool will ever write. Target, type, reason, and content are caller-supplied; the path is derived server-side from `owner`, so cross-file writes are physically impossible through this tool.
- `temp_list_my_entries` — list the caller's own proposed entries, optionally filtered by status.

**operations_** — live ops data, gated by `operations.ga4` / `operations.linear_read` / `operations.linear_write`:

- `operations_ga4_query` — GA4 `runReport` against property `GA4_PROPERTY_ID`.
- `operations_linear_search_issues`, `operations_linear_get_issue` — read.
- `operations_linear_create_issue`, `operations_linear_update_issue` — write.

See [moltbank-kb/wiki/ops/mcp-write-enforcement-plan.md](https://github.com/moltbankhq/moltbank-kb/blob/main/wiki/ops/mcp-write-enforcement-plan.md) for the full rollout plan including the honor-system removal checklist.

### Visibility tiers

| Tier | Sees |
| --- | --- |
| `public` | files with `visibility: public` |
| `internal` | `public` + `internal` |
| `secret` | everything |

A `secret` file is never returned — not in reads, not in lists, not in
searches — to a non-`secret` caller. A read request against a file above the
caller's tier returns "not found" to avoid leaking existence.

---

## Environment variables

Everything lives in env vars — no DB required. Full list in `.env.example`.

```
# GitHub access (pick one)
GITHUB_APP_ID=                   # recommended: GitHub App installation
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=          # PEM, multiline OK
# — or —
GITHUB_TOKEN=                    # fine-grained PAT, read-only on moltbank-kb

GITHUB_REPO=moltbankhq/moltbank-kb
GITHUB_BRANCH=main
GITHUB_WEBHOOK_SECRET=

# Auth
MCP_TOKENS={"tok_xxxx":{"name":"paperclip-prod","max_visibility":"internal","rate_limit_per_min":60}}
ADMIN_TOKEN=a-long-random-string

# Tuning
LOG_LEVEL=info
CACHE_TTL_SECONDS=600
VAULT_CACHE_DIR=/tmp/moltbank-kb

# Local-dev only: skip GitHub entirely and index VAULT_CACHE_DIR as-is
VAULT_OFFLINE_MODE=false
```

`MCP_TOKENS` is a JSON object mapping token → consumer config:

```json
{
  "tok_paperclip_xxx": { "name": "paperclip-prod",        "max_visibility": "internal", "rate_limit_per_min": 60 },
  "tok_claude_yyy":    { "name": "claude-ai-connector",   "max_visibility": "internal", "rate_limit_per_min": 120 },
  "tok_cap_zzz":       { "name": "cap-admin",             "max_visibility": "secret",   "rate_limit_per_min": 300, "owner": "cap", "operations": { "ga4": true, "linear_read": true, "linear_write": true } },
  "tok_daniel_agent":  { "name": "daniel-agent",          "max_visibility": "internal", "rate_limit_per_min": 60,  "owner": "daniel", "operations": { "ga4": true, "linear_read": true, "linear_write": true } },
  "tok_openai_aaa":    { "name": "openai-assistant",      "max_visibility": "internal", "rate_limit_per_min": 120 },
  "tok_hermes_bbb":    { "name": "hermes",                "max_visibility": "internal", "rate_limit_per_min": 120 },
  "tok_pub_www":       { "name": "public-wiki-preview",   "max_visibility": "public",   "rate_limit_per_min": 30 }
}
```

Consumer config fields:

- `name` — human-readable, used in logs.
- `max_visibility` — `public | internal | secret`. Tier hierarchy, enforced server-side.
- `rate_limit_per_min` — sliding-window request cap.
- `owner` (optional) — `cap | jesus | daniel | marielba`. Enables `temp_propose_change` and hard-scopes writes to `temp/<owner>.md`.
- `operations` (optional) — `{ ga4?: boolean, linear_read?: boolean, linear_write?: boolean }`. Each flag gates a family of `operations_*` tools.

**Generating a token:** any random, URL-safe string works. Recommended:
`openssl rand -hex 24` and prefix it with something identifying (`tok_<name>_`).

---

## Local development

```bash
pnpm install

# One-off: create a local env file
cp .env.example .env.local

# Option 1: offline mode — point at a local clone of moltbank-kb
# (fastest iteration, no GitHub token needed)
echo "VAULT_OFFLINE_MODE=true" >> .env.local
echo "VAULT_CACHE_DIR=$HOME/code/moltbank-kb" >> .env.local

# Option 2: point at real GitHub (set GITHUB_APP_* or GITHUB_TOKEN)

pnpm dev                     # next dev on :3000
pnpm test                    # vitest
pnpm typecheck               # tsc --noEmit
pnpm build                   # production build
```

### Testing with `mcp-inspector`

```bash
npx @modelcontextprotocol/inspector
# In the UI: Transport "Streamable HTTP"
# URL: http://localhost:3000/api/mcp
# Headers: Authorization: Bearer <your token>
```

### Testing with curl

**List tools:**

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "authorization: Bearer $MCP_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

**Read a file:**

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "authorization: Bearer $MCP_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":2,
    "method":"tools/call",
    "params":{
      "name":"vault_read_file",
      "arguments":{"path":"wiki/overview/what-is-moltbank.md"}
    }
  }' | jq
```

**Search:**

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "authorization: Bearer $MCP_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":3,
    "method":"tools/call",
    "params":{
      "name":"vault_search",
      "arguments":{"query":"onboarding","limit":10}
    }
  }' | jq
```

**Health:**

```bash
curl -s http://localhost:3000/api/health | jq
```

---

## Deploy

See [DEPLOY.md](./DEPLOY.md). One sentence: `vercel --prod`, set env vars,
point a GitHub webhook at `/api/github-webhook`. Use a random Vercel URL and
do not add it to DNS — this server is privileged and should not be public.

---

## Security model

- **Bearer tokens only.** No cookies, no sessions. Every request carries its own token.
- **Server-side visibility filter on every tool.** Client-supplied tier is ignored — only the server-side map matters.
- **Path traversal is rejected.** `..`, absolute paths, NUL bytes, and symlinks that escape the vault root are all denied.
- **Webhook HMAC-SHA-256.** Signature verified with `timingSafeEqual` before the body is even parsed.
- **Read-only vault.** No mutation tools. No shell access. No arbitrary HTTP.
- **Structured logs only.** File bodies and tokens are never logged; token values never appear in responses. Log records include consumer name, tool, input/output size, single path (if any), result count, and duration.
- **Rate limits per token.** Sliding 60-second window enforced in memory.

---

## Project layout

```
app/
  api/
    mcp/route.ts
    github-webhook/route.ts
    admin/refresh/route.ts
    health/route.ts
src/
  auth/{tokens,rate-limit}.ts
  vault/{sync,index,search,visibility,types}.ts
  mcp/{server,tools/*}.ts
  logging.ts
  errors.ts
tests/
  auth.test.ts
  visibility.test.ts
  webhook.test.ts
  tools/{search,read-file,list-section}.test.ts
  integration/mcp-tools.test.ts
  fixtures/mini-vault/            # small test vault
```
