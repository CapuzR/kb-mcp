import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getVaultManager } from '@/vault/sync';
import { extractBearer } from '@/auth/tokens';
import { logError, logInfo, logWarn } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest): Promise<Response> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    logError({ event: 'admin_misconfigured', ts: new Date().toISOString(), reason: 'ADMIN_TOKEN not set' });
    return new Response('Not configured', { status: 500 });
  }
  const presented =
    extractBearer(req.headers.get('authorization')) ??
    req.headers.get('x-admin-token') ??
    '';

  if (!presented || !constantTimeEqual(presented, expected)) {
    logWarn({ event: 'admin_unauthorized', ts: new Date().toISOString() });
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const idx = await getVaultManager().refresh();
    logInfo({
      event: 'admin_refresh_ok',
      ts: new Date().toISOString(),
      sha: idx.sha,
      indexed_files: idx.files.size,
    });
    return Response.json({ ok: true, sha: idx.sha, indexed_files: idx.files.size });
  } catch (err) {
    logError({ event: 'admin_refresh_failed', ts: new Date().toISOString(), error: (err as Error).message });
    return new Response('Refresh failed', { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response('Method not allowed', { status: 405 });
}
