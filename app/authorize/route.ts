import { NextRequest } from 'next/server';
import { isValidBearerToken, issueAuthCode } from '@/auth/oauth';
import { logInfo, logWarn } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 authorization endpoint.
 *
 * GET  /authorize — render a tiny HTML form where the user pastes their bearer
 *                   token (the one from MCP_TOKENS).
 * POST /authorize — validate the token, mint a PKCE-bound authorization code,
 *                   redirect back to the client's redirect_uri.
 *
 * The usual OAuth params travel as query string on GET; we forward them into
 * hidden form fields so POST is self-contained.
 */

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseParams(search: URLSearchParams): AuthParams {
  return {
    client_id: search.get('client_id') ?? '',
    redirect_uri: search.get('redirect_uri') ?? '',
    response_type: search.get('response_type') ?? '',
    code_challenge: search.get('code_challenge') ?? '',
    code_challenge_method: search.get('code_challenge_method') ?? '',
    state: search.get('state') ?? '',
    scope: search.get('scope') ?? '',
  };
}

function validateParams(p: AuthParams): string | null {
  if (p.response_type !== 'code') return 'Only response_type=code is supported';
  if (!p.redirect_uri) return 'redirect_uri is required';
  try {
    const u = new URL(p.redirect_uri);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      return 'redirect_uri must be HTTPS (or localhost for testing)';
    }
  } catch {
    return 'redirect_uri must be a valid URL';
  }
  if (!p.code_challenge) return 'PKCE code_challenge is required';
  if (p.code_challenge_method !== 'S256') return 'code_challenge_method must be S256';
  return null;
}

function renderForm(p: AuthParams, error?: string): Response {
  const redirectHost = (() => {
    try {
      return new URL(p.redirect_uri).host;
    } catch {
      return p.redirect_uri;
    }
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex,nofollow" />
<title>Authorize — MoltBank Knowledge Vault</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0b0c;
    color: #e5e5e5;
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    background: #141416;
    border: 1px solid #2a2a2e;
    border-radius: 12px;
    padding: 32px;
    max-width: 440px;
    width: 100%;
  }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { color: #a3a3a3; margin: 0 0 20px; font-size: 14px; line-height: 1.5; }
  strong { color: #e5e5e5; }
  label { display: block; font-size: 13px; margin-bottom: 8px; color: #cfcfcf; }
  input[type=password] {
    width: 100%; box-sizing: border-box;
    background: #0b0b0c; color: #e5e5e5;
    border: 1px solid #3a3a3e; border-radius: 8px;
    padding: 10px 12px; font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  input[type=password]:focus { outline: 2px solid #5e81ff; outline-offset: 1px; }
  button {
    margin-top: 16px; width: 100%;
    background: #5e81ff; color: white; border: 0;
    border-radius: 8px; padding: 10px; font-size: 14px;
    font-weight: 600; cursor: pointer;
  }
  button:hover { background: #4b6fe8; }
  .error {
    background: #3a1515; color: #ffb3b3; border: 1px solid #5a2020;
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
    margin-bottom: 16px;
  }
  .host {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: #cfcfcf;
    background: #0b0b0c; border: 1px solid #2a2a2e;
    padding: 2px 6px; border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP client</h1>
    <p>A client at <span class="host">${escapeHtml(redirectHost)}</span> is requesting access to the MoltBank Knowledge Vault. Paste your MCP access token to approve.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/authorize" autocomplete="off">
      <input type="hidden" name="client_id" value="${escapeHtml(p.client_id)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirect_uri)}" />
      <input type="hidden" name="response_type" value="${escapeHtml(p.response_type)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(p.code_challenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.code_challenge_method)}" />
      <input type="hidden" name="state" value="${escapeHtml(p.state)}" />
      <input type="hidden" name="scope" value="${escapeHtml(p.scope)}" />
      <label for="token">MoltBank KB access token</label>
      <input id="token" type="password" name="token" required placeholder="tok_..." autocomplete="off" spellcheck="false" autofocus />
      <button type="submit">Approve</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: error ? 400 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; frame-ancestors 'none'",
    },
  });
}

function errorRedirect(redirectUri: string, state: string, error: string, description?: string): Response {
  try {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    return Response.redirect(u.toString(), 302);
  } catch {
    return new Response(`Invalid redirect_uri: ${redirectUri}`, { status: 400 });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const params = parseParams(url.searchParams);

  const err = validateParams(params);
  if (err) {
    if (params.redirect_uri) {
      return errorRedirect(params.redirect_uri, params.state, 'invalid_request', err);
    }
    return new Response(err, { status: 400 });
  }

  return renderForm(params);
}

export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData();
  const params: AuthParams = {
    client_id: String(form.get('client_id') ?? ''),
    redirect_uri: String(form.get('redirect_uri') ?? ''),
    response_type: String(form.get('response_type') ?? ''),
    code_challenge: String(form.get('code_challenge') ?? ''),
    code_challenge_method: String(form.get('code_challenge_method') ?? ''),
    state: String(form.get('state') ?? ''),
    scope: String(form.get('scope') ?? ''),
  };
  const token = String(form.get('token') ?? '').trim();

  const paramErr = validateParams(params);
  if (paramErr) {
    return errorRedirect(params.redirect_uri, params.state, 'invalid_request', paramErr);
  }

  if (!isValidBearerToken(token)) {
    logWarn({ event: 'oauth_authorize_rejected', ts: new Date().toISOString(), reason: 'invalid_token' });
    return renderForm(params, 'That token is not valid. Check for typos or ask the vault admin for a new one.');
  }

  const code = issueAuthCode(token, params.code_challenge, params.redirect_uri);

  logInfo({
    event: 'oauth_authorize_approved',
    ts: new Date().toISOString(),
    redirect_host: new URL(params.redirect_uri).host,
  });

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);
  return Response.redirect(redirect.toString(), 302);
}
