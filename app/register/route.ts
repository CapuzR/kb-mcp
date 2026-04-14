import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { logInfo } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Minimal RFC 7591 Dynamic Client Registration.
 *
 * Anyone can register. We don't persist anything — we just return a synthesized
 * client_id so DCR-style clients (Claude.ai, OpenAI) can complete discovery.
 * The actual per-user auth happens at /authorize where the user pastes their
 * bearer token from MCP_TOKENS.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];
  const clientName = typeof body.client_name === 'string' ? body.client_name : 'mcp-client';

  const clientId = 'dcr_' + crypto.randomBytes(12).toString('hex');

  logInfo({
    event: 'oauth_client_registered',
    ts: new Date().toISOString(),
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris.length,
  });

  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: clientName,
    },
    {
      status: 201,
      headers: {
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
      'access-control-allow-headers': 'Content-Type',
    },
  });
}
