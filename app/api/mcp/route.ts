import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveCaller } from '@/auth/tokens';
import { enforceRateLimit } from '@/auth/rate-limit';
import { buildMcpServerForCaller } from '@/mcp/server';
import { AppError, RateLimitedError, UnauthorizedError } from '@/errors';
import { logError, logInfo } from '@/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json' } }
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
      return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="moltbank-kb-mcp"',
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
    return response;
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
