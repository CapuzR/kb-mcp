import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveCaller } from '@/auth/tokens';
import { enforceRateLimit } from '@/auth/rate-limit';
import { buildMcpServerForCaller } from '@/mcp/server';
import { AppError, RateLimitedError, UnauthorizedError } from '@/errors';
import { logError, logInfo } from '@/logging';
import { getBaseUrl } from '@/auth/urls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json', ...CORS_HEADERS } }
  );
}

async function handle(req: NextRequest): Promise<Response> {
  // AuthN/Z happens before we hand off to the MCP transport.
  let caller;
  try {
    caller = resolveCaller(req.headers.get('authorization'));
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      logInfo({
        event: 'auth_rejected',
        ts: new Date().toISOString(),
        path: '/api/mcp',
        reason: err.message,
      });
      // Point OAuth-capable clients at our discovery metadata so they can
      // run the authorization flow (RFC 9728 §5.1).
      const base = getBaseUrl(req);
      const wwwAuth =
        `Bearer realm="moltbank-kb-mcp", ` +
        `resource_metadata="${base}/.well-known/oauth-protected-resource"`;
      return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': wwwAuth,
          ...CORS_HEADERS,
        },
      });
    }
    logError({ event: 'auth_misconfigured', ts: new Date().toISOString(), error: (err as Error).message });
    return jsonRpcError(500, -32603, 'Server misconfigured');
  }

  try {
    enforceRateLimit(caller.token, caller.consumer.rate_limit_per_min);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retry_after_ms: err.retryAfterMs }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(Math.ceil(err.retryAfterMs / 1000)),
            ...CORS_HEADERS,
          },
        }
      );
    }
    throw err;
  }

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const server = buildMcpServerForCaller(caller);
    await server.connect(transport);
    // The SDK's transport fully consumes the Request, so it's safe to pass directly.
    const response = await transport.handleRequest(req, {
      authInfo: {
        token: caller.token,
        clientId: caller.consumer.name,
        scopes: [caller.consumer.max_visibility],
        extra: { consumer: caller.consumer },
      },
    });
    return withCors(response);
  } catch (err) {
    const msg = err instanceof AppError ? err.message : 'Internal error';
    const status = err instanceof AppError ? err.status : 500;
    logError({
      event: 'mcp_handler_error',
      ts: new Date().toISOString(),
      consumer: caller.consumer.name,
      error: (err as Error).message,
    });
    return jsonRpcError(status, -32603, msg);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(): Promise<Response> {
  return jsonRpcError(405, -32000, 'Method not allowed. Use POST with JSON-RPC body.');
}

export async function DELETE(): Promise<Response> {
  return jsonRpcError(405, -32000, 'Method not allowed.');
}

// CORS preflight — required so browser-based MCP clients (Claude.ai) can call
// POST /api/mcp with the Authorization header cross-origin.
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
      'access-control-max-age': '86400',
    },
  });
}
