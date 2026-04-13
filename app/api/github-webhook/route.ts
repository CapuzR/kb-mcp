import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getVaultManager } from '@/vault/sync';
import { logError, logInfo, logWarn } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Timing-safe comparison of two hex signatures.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logError({ event: 'webhook_misconfigured', ts: new Date().toISOString(), reason: 'GITHUB_WEBHOOK_SECRET not set' });
    return new Response('Webhook not configured', { status: 500 });
  }

  const signatureHeader = req.headers.get('x-hub-signature-256');
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return new Response('Missing signature', { status: 401 });
  }
  const deliveryId = req.headers.get('x-github-delivery') ?? 'unknown';
  const event = req.headers.get('x-github-event') ?? 'unknown';

  const raw = Buffer.from(await req.arrayBuffer());
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqual(signatureHeader, expected)) {
    logWarn({ event: 'webhook_bad_signature', ts: new Date().toISOString(), delivery: deliveryId });
    return new Response('Bad signature', { status: 401 });
  }

  // Parse the body only after signature validation passes.
  let body: Record<string, unknown> = {};
  try {
    body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (event === 'ping') {
    return Response.json({ ok: true, pong: true });
  }

  if (event !== 'push') {
    logInfo({
      event: 'webhook_ignored',
      ts: new Date().toISOString(),
      github_event: event,
      delivery: deliveryId,
    });
    return Response.json({ ok: true, ignored: true });
  }

  const wantBranch = `refs/heads/${process.env.GITHUB_BRANCH || 'main'}`;
  if (body.ref !== wantBranch) {
    logInfo({
      event: 'webhook_ignored_branch',
      ts: new Date().toISOString(),
      ref: typeof body.ref === 'string' ? body.ref : null,
      delivery: deliveryId,
    });
    return Response.json({ ok: true, ignored: true, reason: 'non-target branch' });
  }

  try {
    const idx = await getVaultManager().refresh();
    logInfo({
      event: 'webhook_refresh_ok',
      ts: new Date().toISOString(),
      sha: idx.sha,
      indexed_files: idx.files.size,
      delivery: deliveryId,
    });
    return Response.json({ ok: true, sha: idx.sha, indexed_files: idx.files.size });
  } catch (err) {
    logError({
      event: 'webhook_refresh_failed',
      ts: new Date().toISOString(),
      error: (err as Error).message,
      delivery: deliveryId,
    });
    return new Response('Refresh failed', { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response('Method not allowed', { status: 405 });
}
