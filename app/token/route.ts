import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { ACCESS_TOKEN_EXPIRES_IN, verifyAuthCode } from '@/auth/oauth';
import { logInfo, logWarn } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(status: number, error: string, description?: string): Response {
  return new Response(
    JSON.stringify(description ? { error, error_description: description } : { error }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    }
  );
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = base64url(crypto.createHash('sha256').update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * OAuth 2.1 token endpoint. Exchanges an authorization code + PKCE verifier
 * for the bearer token the user originally approved in /authorize.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();

  let params: URLSearchParams;
  if (ct.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await req.text());
  } else if (ct.includes('application/json')) {
    try {
      const body = (await req.json()) as Record<string, string>;
      params = new URLSearchParams(body);
    } catch {
      return jsonError(400, 'invalid_request', 'Malformed JSON body');
    }
  } else if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    params = new URLSearchParams();
    for (const [k, v] of form.entries()) params.set(k, String(v));
  } else {
    // Tolerate missing content-type
    const text = await req.text();
    try {
      params = new URLSearchParams(text);
    } catch {
      return jsonError(400, 'invalid_request', 'Unsupported body format');
    }
  }

  const grantType = params.get('grant_type') ?? '';
  const code = params.get('code') ?? '';
  const verifier = params.get('code_verifier') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';

  if (grantType !== 'authorization_code') {
    return jsonError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
  }
  if (!code || !verifier || !redirectUri) {
    return jsonError(400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
  }

  let payload;
  try {
    payload = verifyAuthCode(code);
  } catch (err) {
    logWarn({ event: 'oauth_token_rejected', ts: new Date().toISOString(), reason: (err as Error).message });
    return jsonError(400, 'invalid_grant', 'Authorization code is invalid or expired');
  }

  if (payload.ru !== redirectUri) {
    return jsonError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
  }

  if (!verifyPkce(verifier, payload.cc)) {
    return jsonError(400, 'invalid_grant', 'PKCE verifier does not match code_challenge');
  }

  logInfo({ event: 'oauth_token_issued', ts: new Date().toISOString() });

  return new Response(
    JSON.stringify({
      access_token: payload.bt,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_EXPIRES_IN,
      scope: 'mcp',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    }
  );
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
  });
}
