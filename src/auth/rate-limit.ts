import { RateLimitedError } from '../errors';

/**
 * Sliding-window in-memory rate limiter keyed by token. Good enough for our
 * expected volume (low-traffic internal tool); swap for KV/Redis if we ever
 * front this with autoscaled replicas doing heavy traffic.
 */

const WINDOW_MS = 60_000;

interface Bucket {
  /** timestamps (ms) of recent hits, oldest first */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** ms until the next slot frees up (0 if already allowed) */
  retryAfterMs: number;
}

export function checkRateLimit(token: string, limitPerMin: number, now: number = Date.now()): RateLimitResult {
  const threshold = now - WINDOW_MS;
  let bucket = buckets.get(token);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(token, bucket);
  }
  // prune expired
  while (bucket.hits.length > 0 && bucket.hits[0] <= threshold) {
    bucket.hits.shift();
  }
  if (bucket.hits.length >= limitPerMin) {
    const oldest = bucket.hits[0];
    const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
    return { allowed: false, remaining: 0, limit: limitPerMin, retryAfterMs };
  }
  bucket.hits.push(now);
  return {
    allowed: true,
    remaining: limitPerMin - bucket.hits.length,
    limit: limitPerMin,
    retryAfterMs: 0,
  };
}

export function enforceRateLimit(token: string, limitPerMin: number): RateLimitResult {
  const result = checkRateLimit(token, limitPerMin);
  if (!result.allowed) {
    throw new RateLimitedError(result.retryAfterMs);
  }
  return result;
}

/** Clear all rate-limit buckets. Only for tests. */
export function __resetRateLimits(): void {
  buckets.clear();
}
