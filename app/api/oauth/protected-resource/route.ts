import { NextRequest } from 'next/server';
import { getBaseUrl } from '@/auth/urls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const base = getBaseUrl(req);
  return Response.json(
    {
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
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
