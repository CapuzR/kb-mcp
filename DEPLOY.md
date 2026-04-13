# Deploying moltbank-kb-mcp

## TL;DR

```bash
vercel link                       # pick "moltbank-kb-mcp" (new project)
vercel env add MCP_TOKENS production
vercel env add ADMIN_TOKEN production
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_INSTALLATION_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production
vercel env add GITHUB_WEBHOOK_SECRET production
vercel env add GITHUB_REPO production            # moltbankhq/moltbank-kb
vercel env add GITHUB_BRANCH production          # main
vercel --prod
```

Then wire up the GitHub webhook (see below).

---

## 1. Set up the GitHub App

We use a GitHub App install (not a PAT) so the token is scoped to exactly one
repo, auto-rotated every hour, and easy to revoke.

1. Go to **https://github.com/organizations/moltbankhq/settings/apps** → **New GitHub App**.
2. App name: `moltbank-kb-mcp`. Homepage URL: your Vercel production URL (after first deploy).
3. **Permissions → Repository → Contents: Read-only**. No other permissions.
4. **Subscribe to events: Push**.
5. Webhook URL: leave blank for now (we'll attach a webhook at the repo level, not the App level).
6. Create the App. Note the **App ID**.
7. Generate a **Private key** (PEM file). Save it.
8. **Install App** → install on `moltbankhq/moltbank-kb` only. Note the **Installation ID** (visible in the URL after install, or via API: `GET /orgs/moltbankhq/installation`).

Set these on Vercel:

```bash
vercel env add GITHUB_APP_ID production               # <numeric app id>
vercel env add GITHUB_APP_INSTALLATION_ID production  # <numeric install id>
vercel env add GITHUB_APP_PRIVATE_KEY production      # paste the full PEM
```

When pasting the PEM into Vercel, keep newlines as-is (multiline) — the code
handles both multiline and `\n`-escaped single-line form.

---

## 2. Generate tokens and admin key

```bash
# one token per consumer; prefix keeps logs readable
for name in paperclip-prod claude-ai-connector cap-admin openai-assistant hermes public-wiki-preview; do
  printf '%s: tok_%s_%s\n' "$name" "$(echo $name | tr '-' '_')" "$(openssl rand -hex 16)"
done
```

Assemble them into `MCP_TOKENS` JSON (single line):

```json
{"tok_paperclip_prod_...":{"name":"paperclip-prod","max_visibility":"internal","rate_limit_per_min":60},
 "tok_cap_admin_...":{"name":"cap-admin","max_visibility":"secret","rate_limit_per_min":300},
 "tok_public_wiki_preview_...":{"name":"public-wiki-preview","max_visibility":"public","rate_limit_per_min":30}}
```

```bash
vercel env add MCP_TOKENS production      # paste JSON
vercel env add ADMIN_TOKEN production     # openssl rand -hex 32
```

---

## 3. First deploy

```bash
vercel --prod
```

Vercel will give you a URL like `moltbank-kb-mcp-xyz123.vercel.app`. **Do not
add a custom domain.** Keep it private — anyone with the URL + a token can
query the vault. Distribute tokens out-of-band (1Password).

Smoke test:

```bash
curl https://moltbank-kb-mcp-xyz123.vercel.app/api/health
# -> {"status":"ok","vault_sha":null,...} on first request
# -> {"status":"ok","vault_sha":"...","indexed_files":N,...} after first tool call
```

First MCP call will trigger the clone, which takes a few seconds. Subsequent
calls in the same lambda serve from memory.

---

## 4. Wire up the push webhook

Generate a webhook secret:

```bash
WEBHOOK_SECRET=$(openssl rand -hex 32)
vercel env add GITHUB_WEBHOOK_SECRET production     # paste $WEBHOOK_SECRET
vercel --prod                                       # redeploy to pick it up
```

In the moltbank-kb repo: **Settings → Webhooks → Add webhook**.

- **Payload URL:** `https://moltbank-kb-mcp-xyz123.vercel.app/api/github-webhook`
- **Content type:** `application/json`
- **Secret:** paste `$WEBHOOK_SECRET`
- **SSL verification:** Enabled
- **Events:** Just the `push` event
- **Active:** checked

Save. GitHub will immediately send a `ping`; check the "Recent Deliveries" tab
and confirm 200 OK.

Test an end-to-end refresh:

```bash
# push a trivial change to moltbank-kb main
# then:
curl https://moltbank-kb-mcp-xyz123.vercel.app/api/health
# vault_sha should update to the new commit sha
```

---

## 5. Manual refresh (break-glass)

```bash
curl -X POST https://moltbank-kb-mcp-xyz123.vercel.app/api/admin/refresh \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"sha":"<new sha>","indexed_files":N}
```

---

## 6. Rotating tokens / adding consumers

1. Generate a new token: `openssl rand -hex 24` (with an identifying prefix).
2. Update the `MCP_TOKENS` env var in Vercel (edit existing value).
3. Redeploy: `vercel --prod`. Takes <30s.
4. Revoke: remove the entry from `MCP_TOKENS` and redeploy.

There is no separate rotation ceremony — the env var is the source of truth.

---

## Troubleshooting

- **401 on `/api/mcp`**: missing `Authorization: Bearer`, bad token, or token
  not in `MCP_TOKENS`. Check Vercel logs; auth rejects are logged with reason.
- **`health` shows `vault_sha: null`**: no call yet in this lambda. Hit any
  tool and refresh. If it stays null, GitHub auth is failing — check
  `vault_refresh_failed` in logs.
- **Webhook 401**: signature mismatch. Usually `GITHUB_WEBHOOK_SECRET` out of
  sync between GitHub and Vercel. Regenerate on both sides.
- **Rate-limited**: in-memory counters reset when the lambda is recycled.
  Bumping `rate_limit_per_min` in `MCP_TOKENS` takes effect on next deploy.
- **"Stateless transport cannot be reused" in logs**: only appears if the
  transport object is accidentally reused across requests. The route handler
  creates a fresh transport per call — this should not happen in production.
