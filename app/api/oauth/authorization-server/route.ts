import { NextRequest } from 'next/server';
import { getBaseUrl } from '@/auth/urls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const base = getBaseUrl(req);
  return Response.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      // Tell clients the access tokens we issue work on the MCP resource.
      service_documentation: `${base}`,
    },
    {
      headers: {
        'cache-control': 'public, max-age=300',
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
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
  });
}
