import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadTokenMap,
  resolveCaller,
  extractBearer,
  __resetTokenCache,
} from '../src/auth/tokens';
import { checkRateLimit, __resetRateLimits } from '../src/auth/rate-limit';
import { UnauthorizedError, RateLimitedError } from '../src/errors';
import { TEST_MCP_TOKENS } from './helpers/build-test-index';

beforeEach(() => {
  __resetTokenCache();
  __resetRateLimits();
  process.env.MCP_TOKENS = TEST_MCP_TOKENS;
});

describe('extractBearer', () => {
  it('returns the token for a well-formed header', () => {
    expect(extractBearer('Bearer tok_abc_123')).toBe('tok_abc_123');
  });
  it('accepts lowercase scheme', () => {
    expect(extractBearer('bearer tok_abc')).toBe('tok_abc');
  });
  it('returns null for missing header', () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
  });
  it('returns null for malformed header', () => {
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer('Bearer tok with spaces')).toBeNull();
  });
});

describe('loadTokenMap', () => {
  it('parses a valid MCP_TOKENS JSON', () => {
    const map = loadTokenMap();
    expect(map.tok_public.name).toBe('public-wiki-preview');
    expect(map.tok_internal.max_visibility).toBe('internal');
  });

  it('rejects invalid JSON', () => {
    expect(() => loadTokenMap('not json')).toThrow(/valid JSON/);
  });

  it('rejects missing visibility', () => {
    const bad = JSON.stringify({ tok_x: { name: 'x', rate_limit_per_min: 10 } });
    expect(() => loadTokenMap(bad)).toThrow(/max_visibility/);
  });

  it('rejects invalid visibility', () => {
    const bad = JSON.stringify({
      tok_x: { name: 'x', max_visibility: 'top-secret', rate_limit_per_min: 10 },
    });
    expect(() => loadTokenMap(bad)).toThrow(/max_visibility/);
  });

  it('rejects non-positive rate limit', () => {
    const bad = JSON.stringify({
      tok_x: { name: 'x', max_visibility: 'public', rate_limit_per_min: 0 },
    });
    expect(() => loadTokenMap(bad)).toThrow(/rate_limit_per_min/);
  });
});

describe('resolveCaller', () => {
  it('accepts a valid token', () => {
    const caller = resolveCaller('Bearer tok_public');
    expect(caller.consumer.name).toBe('public-wiki-preview');
    expect(caller.consumer.max_visibility).toBe('public');
  });

  it('rejects a missing header', () => {
    expect(() => resolveCaller(null)).toThrow(UnauthorizedError);
  });

  it('rejects a malformed header', () => {
    expect(() => resolveCaller('NotBearer tok_public')).toThrow(UnauthorizedError);
  });

  it('rejects an unknown token', () => {
    expect(() => resolveCaller('Bearer tok_does_not_exist')).toThrow(UnauthorizedError);
  });
});

describe('rate limit', () => {
  it('allows up to the limit in a window', () => {
    const results = [0, 0, 0].map(() => checkRateLimit('k1', 3));
    expect(results.every(r => r.allowed)).toBe(true);
    expect(checkRateLimit('k1', 3).allowed).toBe(false);
  });

  it('throws RateLimitedError when enforce is called over limit', async () => {
    const { enforceRateLimit } = await import('../src/auth/rate-limit.js');
    for (let i = 0; i < 2; i++) enforceRateLimit('k2', 2);
    expect(() => enforceRateLimit('k2', 2)).toThrow(RateLimitedError);
  });

  it('keys are isolated per token', () => {
    expect(checkRateLimit('a', 1).allowed).toBe(true);
    expect(checkRateLimit('a', 1).allowed).toBe(false);
    expect(checkRateLimit('b', 1).allowed).toBe(true);
  });
});
