import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  issueAuthCode,
  verifyAuthCode,
  isValidBearerToken,
  pkceChallengeFromVerifier,
} from '../src/auth/oauth';
import { __resetTokenCache } from '../src/auth/tokens';
import { TEST_MCP_TOKENS } from './helpers/build-test-index';

beforeAll(() => {
  process.env.ADMIN_TOKEN = 'test-admin-token-for-oauth-signing';
});

beforeEach(() => {
  __resetTokenCache();
  process.env.MCP_TOKENS = TEST_MCP_TOKENS;
});

describe('pkceChallengeFromVerifier', () => {
  it('matches the RFC 7636 S256 computation', () => {
    // Test vector from RFC 7636 Appendix B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = pkceChallengeFromVerifier(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('auth code signing', () => {
  it('round-trips a valid payload', () => {
    const code = issueAuthCode('tok_internal', 'challenge_abc', 'https://claude.ai/cb');
    const decoded = verifyAuthCode(code);
    expect(decoded.bt).toBe('tok_internal');
    expect(decoded.cc).toBe('challenge_abc');
    expect(decoded.ru).toBe('https://claude.ai/cb');
    expect(decoded.exp).toBeGreaterThan(Date.now());
  });

  it('rejects a code with a tampered payload', () => {
    const code = issueAuthCode('tok_internal', 'cc', 'https://x.example/cb');
    const [body, sig] = code.split('.');
    const tampered = body.slice(0, -2) + 'aa' + '.' + sig;
    expect(() => verifyAuthCode(tampered)).toThrow();
  });

  it('rejects a code signed with a different key', () => {
    process.env.ADMIN_TOKEN = 'key-A';
    const code = issueAuthCode('tok_internal', 'cc', 'https://x.example/cb');
    process.env.ADMIN_TOKEN = 'key-B';
    expect(() => verifyAuthCode(code)).toThrow();
    process.env.ADMIN_TOKEN = 'test-admin-token-for-oauth-signing';
  });

  it('rejects an expired code', () => {
    // Build a code with exp in the past by calling signAuthCode-equivalent manually
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() - 10 * 60_000; // 10 min ago
      const code = issueAuthCode('tok_internal', 'cc', 'https://x.example/cb');
      Date.now = originalNow;
      expect(() => verifyAuthCode(code)).toThrow(/expired/);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('isValidBearerToken', () => {
  it('accepts a token present in MCP_TOKENS', () => {
    expect(isValidBearerToken('tok_internal')).toBe(true);
    expect(isValidBearerToken('tok_secret')).toBe(true);
  });

  it('rejects an unknown token', () => {
    expect(isValidBearerToken('tok_nope')).toBe(false);
    expect(isValidBearerToken('')).toBe(false);
  });
});

describe('end-to-end OAuth flow (route handlers)', () => {
  it('authorize POST with valid token issues a code that exchanges to the original token', async () => {
    // Simulate the /authorize POST (form-encoded)
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = pkceChallengeFromVerifier(verifier);
    const redirectUri = 'https://claude.ai/oauth/callback';

    const { POST: authorizePost } = await import('../app/authorize/route');
    const form = new URLSearchParams();
    form.set('client_id', 'tok_internal');
    form.set('redirect_uri', redirectUri);
    form.set('response_type', 'code');
    form.set('code_challenge', challenge);
    form.set('code_challenge_method', 'S256');
    form.set('state', 'opaque_state_123');
    form.set('scope', 'mcp');
    form.set('token', 'tok_internal');

    const authReq = new Request('http://localhost/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const authRes = await authorizePost(authReq as any);
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location')!;
    expect(location).toMatch(/^https:\/\/claude\.ai\/oauth\/callback\?/);
    const locUrl = new URL(location);
    const code = locUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(locUrl.searchParams.get('state')).toBe('opaque_state_123');

    // Now POST /token
    const { POST: tokenPost } = await import('../app/token/route');
    const tokenBody = new URLSearchParams();
    tokenBody.set('grant_type', 'authorization_code');
    tokenBody.set('code', code!);
    tokenBody.set('code_verifier', verifier);
    tokenBody.set('redirect_uri', redirectUri);
    tokenBody.set('client_id', 'tok_internal');

    const tokReq = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    const tokRes = await tokenPost(tokReq as any);
    expect(tokRes.status).toBe(200);
    const tokJson = (await tokRes.json()) as { access_token: string; token_type: string };
    expect(tokJson.access_token).toBe('tok_internal');
    expect(tokJson.token_type).toBe('Bearer');
  });

  it('authorize POST with an invalid token re-renders the form with an error', async () => {
    const { POST: authorizePost } = await import('../app/authorize/route');
    const form = new URLSearchParams();
    form.set('client_id', 'whatever');
    form.set('redirect_uri', 'https://claude.ai/cb');
    form.set('response_type', 'code');
    form.set('code_challenge', 'xyz');
    form.set('code_challenge_method', 'S256');
    form.set('state', 's');
    form.set('token', 'tok_does_not_exist');

    const req = new Request('http://localhost/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const res = await authorizePost(req as any);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/not valid/);
  });

  it('token endpoint rejects a PKCE verifier that does not match the challenge', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = pkceChallengeFromVerifier(verifier);
    const redirectUri = 'https://claude.ai/cb';
    const code = issueAuthCode('tok_internal', challenge, redirectUri);

    const { POST: tokenPost } = await import('../app/token/route');
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('code_verifier', 'a_different_verifier_that_wont_match');
    body.set('redirect_uri', redirectUri);

    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const res = await tokenPost(req as any);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_grant');
  });

  it('token endpoint rejects a redirect_uri mismatch', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = pkceChallengeFromVerifier(verifier);
    const code = issueAuthCode('tok_internal', challenge, 'https://claude.ai/cb');

    const { POST: tokenPost } = await import('../app/token/route');
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('code_verifier', verifier);
    body.set('redirect_uri', 'https://evil.example/cb');

    const req = new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const res = await tokenPost(req as any);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_grant');
  });
});

describe('discovery endpoints', () => {
  it('authorization-server returns required fields', async () => {
    const { GET } = await import('../app/api/oauth/authorization-server/route');
    const req = new Request('https://example.test/.well-known/oauth-authorization-server');
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.authorization_endpoint).toMatch(/\/authorize$/);
    expect(json.token_endpoint).toMatch(/\/token$/);
    expect((json.response_types_supported as string[]).includes('code')).toBe(true);
    expect((json.code_challenge_methods_supported as string[]).includes('S256')).toBe(true);
  });

  it('protected-resource returns the mcp resource URL', async () => {
    const { GET } = await import('../app/api/oauth/protected-resource/route');
    const req = new Request('https://example.test/.well-known/oauth-protected-resource');
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.resource).toMatch(/\/api\/mcp$/);
    expect(Array.isArray(json.authorization_servers)).toBe(true);
  });
});
