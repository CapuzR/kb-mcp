import { Visibility, VISIBILITY_TIERS } from '../vault/types';
import { UnauthorizedError } from '../errors';
import { isVisibilityTier } from '../vault/visibility';

/**
 * Team members whose agents can propose wiki changes via temp_propose_change.
 * A token without an `owner` field is read-only (external integrations like
 * Paperclip, Claude.ai connector, etc.) and cannot call any write tool.
 */
export const OWNER_VALUES = ['cap', 'jesus', 'daniel', 'marielba'] as const;
export type Owner = (typeof OWNER_VALUES)[number];

export function isOwner(v: unknown): v is Owner {
  return typeof v === 'string' && (OWNER_VALUES as readonly string[]).includes(v);
}

/**
 * Operation-tool scopes. Independently togglable: an agent may have GA4
 * read-only, Linear read-only, or Linear read+write. `linear_write` implies
 * `linear_read` logically but is not auto-promoted — the consumer config
 * must state both if both are wanted.
 */
export interface OperationScopes {
  ga4?: boolean;
  linear_read?: boolean;
  linear_write?: boolean;
}

export interface ConsumerConfig {
  name: string;
  max_visibility: Visibility;
  rate_limit_per_min: number;
  /**
   * Team-member identity for write scoping. Required to call
   * temp_propose_change; the tool will only write to `temp/<owner>.md`.
   */
  owner?: Owner;
  /**
   * Per-tool operation scopes. Checked in each operations_* tool before
   * hitting the external service.
   */
  operations?: OperationScopes;
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
    const owner = v.owner;
    const operations = v.operations;

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

    const config: ConsumerConfig = { name, max_visibility: maxVis, rate_limit_per_min: rateLimit };

    if (owner !== undefined) {
      if (!isOwner(owner)) {
        throw new Error(
          `MCP_TOKENS["${token}"].owner must be one of ${OWNER_VALUES.join(', ')} (or omitted)`
        );
      }
      config.owner = owner;
    }

    if (operations !== undefined) {
      if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
        throw new Error(`MCP_TOKENS["${token}"].operations must be an object (or omitted)`);
      }
      const ops = operations as Record<string, unknown>;
      const out: OperationScopes = {};
      for (const key of ['ga4', 'linear_read', 'linear_write'] as const) {
        if (ops[key] === undefined) continue;
        if (typeof ops[key] !== 'boolean') {
          throw new Error(`MCP_TOKENS["${token}"].operations.${key} must be boolean`);
        }
        out[key] = ops[key] as boolean;
      }
      config.operations = out;
    }

    result[token] = config;
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
