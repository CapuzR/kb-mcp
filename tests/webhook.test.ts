import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';

// We need to stub the vault manager BEFORE importing the route handler so the
// module-level `getVaultManager()` doesn't try to hit GitHub.
const refresh = vi.fn(async () => ({ sha: 'abc', files: new Map(), rootPath: '/tmp', builtAt: Date.now() }));

vi.mock('../src/vault/sync', () => ({
  getVaultManager: () => ({ refresh, peek: () => null }),
  __resetVaultManager: () => undefined,
}));

const SECRET = 'test-webhook-secret';

beforeAll(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.GITHUB_BRANCH = 'main';
});

afterAll(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function importRoute() {
  return await import('../app/api/github-webhook/route.js');
}

function makeReq(body: string, headers: Record<string, string>): Request {
  return new Request('http://localhost/api/github-webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('github-webhook', () => {
  it('rejects missing signature', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq('{}', { 'x-github-event': 'push' }) as any);
    expect(res.status).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const { POST } = await importRoute();
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await POST(
      makeReq(body, {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=' + 'f'.repeat(64),
      }) as any
    );
    expect(res.status).toBe(401);
  });

  it('accepts a valid push and triggers refresh', async () => {
    refresh.mockClear();
    const { POST } = await importRoute();
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await POST(
      makeReq(body, {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      }) as any
    );
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('ignores pushes to non-target branches', async () => {
    refresh.mockClear();
    const { POST } = await importRoute();
    const body = JSON.stringify({ ref: 'refs/heads/feature-x' });
    const res = await POST(
      makeReq(body, {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      }) as any
    );
    expect(res.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('handles ping event', async () => {
    const { POST } = await importRoute();
    const body = JSON.stringify({ zen: 'speak softly' });
    const res = await POST(
      makeReq(body, {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      }) as any
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pong).toBe(true);
  });
});
