import crypto from 'node:crypto';
import { loadTokenMap } from './tokens';

/**
 * Minimal OAuth 2.1 + PKCE adapter over our static bearer tokens.
 *
 * This lets OAuth-only MCP clients (Claude.ai, OpenAI) connect. The user's
 * existing token from MCP_TOKENS doubles as the OAuth credential — during the
 * authorize flow we show a login page where they paste it.
 *
 * Authorization codes are signed with HMAC-SHA256 so we stay stateless across
 * Vercel lambdas. No DB, no KV.
 */

const CODE_TTL_MS = 5 * 60_000; // 5 min
const ACCESS_TOKEN_EXPIRES_IN = 3600; // reported to clients; our bearer tokens don't actually expire

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Key used to sign authorization codes. Derived from ADMIN_TOKEN so we don't
 * need a new env var; callers must have set ADMIN_TOKEN already for
 * /api/admin/refresh anyway.
 */
function signingKey(): Buffer {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) {
    throw new Error('ADMIN_TOKEN must be set to sign OAuth authorization codes');
  }
  return crypto.createHash('sha256').update('kb-mcp-oauth-v1::' + admin).digest();
}

export interface AuthCodePayload {
  /** The actual MCP bearer token we'll hand back on /token exchange */
  bt: string;
  /** PKCE code_challenge (we only support S256) */
  cc: string;
  /** Redirect URI this code is bound to */
  ru: string;
  /** Expiry (unix ms) */
  exp: number;
}

/** Sign a payload into a compact `<payload>.<sig>` string. */
export function signAuthCode(payload: AuthCodePayload): string {
  const key = signingKey();
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify and decode a signed code. Throws on invalid/expired. */
export function verifyAuthCode(code: string): AuthCodePayload {
  const parts = code.split('.');
  if (parts.length !== 2) throw new Error('Malformed code');
  const [body, sig] = parts;
  const key = signingKey();
  const expectedSig = base64url(crypto.createHmac('sha256', key).update(body).digest());
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Bad signature');
  }
  let payload: AuthCodePayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8')) as AuthCodePayload;
  } catch {
    throw new Error('Malformed code payload');
  }
  if (!payload.bt || !payload.cc || !payload.ru || typeof payload.exp !== 'number') {
    throw new Error('Malformed code payload');
  }
  if (Date.now() > payload.exp) throw new Error('Code expired');
  return payload;
}

/** Issue a fresh signed code for a validated bearer token. */
export function issueAuthCode(bearerToken: string, codeChallenge: string, redirectUri: string): string {
  // Caller must have already validated that bearerToken ∈ MCP_TOKENS.
  return signAuthCode({
    bt: bearerToken,
    cc: codeChallenge,
    ru: redirectUri,
    exp: Date.now() + CODE_TTL_MS,
  });
}

/** Compute the S256 PKCE code_challenge from a verifier. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/** Validate that a bearer token string exists in our token map. */
export function isValidBearerToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  try {
    const map = loadTokenMap();
    return token in map;
  } catch {
    return false;
  }
}

export { ACCESS_TOKEN_EXPIRES_IN, CODE_TTL_MS };
