import { Visibility, VISIBILITY_TIERS } from '../vault/types';
import { UnauthorizedError } from '../errors';
import { isVisibilityTier } from '../vault/visibility';

export interface ConsumerConfig {
  name: string;
  max_visibility: Visibility;
  rate_limit_per_min: number;
}

export interface ResolvedCaller {
  token: string;
  consumer: ConsumerConfig;
}

type TokenMap = Record<string, ConsumerConfig>;

let cachedMap: TokenMap | null = null;
let cachedRaw: string | null = null;

/**
 * Parse MCP_TOKENS into a validated map. We cache the result so repeated
 * requests don't re-parse, but invalidate on env change (useful in tests).
 */
export function loadTokenMap(envValue: string | undefined = process.env.MCP_TOKENS): TokenMap {
  if (!envValue) {
    throw new Error('MCP_TOKENS env var is not set');
  }
  if (envValue === cachedRaw && cachedMap) return cachedMap;

  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch (err) {
    throw new Error(`MCP_TOKENS is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP_TOKENS must be a JSON object');
  }

  const result: TokenMap = {};
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!token || typeof token !== 'string') {
      throw new Error('MCP_TOKENS contains a non-string key');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MCP_TOKENS["${token}"] must be an object`);
    }
    const v = value as Record<string, unknown>;
    const name = v.name;
    const maxVis = v.max_visibility;
    const rateLimit = v.rate_limit_per_min;

    if (typeof name !== 'string' || !name) {
      throw new Error(`MCP_TOKENS["${token}"].name must be a non-empty string`);
    }
    if (!isVisibilityTier(maxVis)) {
      throw new Error(
        `MCP_TOKENS["${token}"].max_visibility must be one of ${VISIBILITY_TIERS.join(', ')}`
      );
    }
    if (typeof rateLimit !== 'number' || !Number.isFinite(rateLimit) || rateLimit <= 0) {
      throw new Error(`MCP_TOKENS["${token}"].rate_limit_per_min must be a positive number`);
    }
    result[token] = { name, max_visibility: maxVis, rate_limit_per_min: rateLimit };
  }

  cachedMap = result;
  cachedRaw = envValue;
  return result;
}

/** Clear the in-process cache. Only for tests. */
export function __resetTokenCache(): void {
  cachedMap = null;
  cachedRaw = null;
}

/**
 * Extract a bearer token from an Authorization header, or null if absent/malformed.
 */
export function extractBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+([A-Za-z0-9_\-.=]+)$/i.exec(authHeader.trim());
  return match ? match[1] : null;
}

/**
 * Resolve an incoming Authorization header to a caller, or throw UnauthorizedError.
 * Timing-safe-ish comparison via map lookup (the token is the key).
 */
export function resolveCaller(authHeader: string | null | undefined): ResolvedCaller {
  const token = extractBearer(authHeader);
  if (!token) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }
  const map = loadTokenMap();
  const consumer = map[token];
  if (!consumer) {
    throw new UnauthorizedError('Invalid token');
  }
  return { token, consumer };
}
