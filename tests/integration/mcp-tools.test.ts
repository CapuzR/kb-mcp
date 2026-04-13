import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FIXTURE_ROOT, buildTestIndex } from '../helpers/build-test-index';

// Mock the vault manager to serve the fixture instead of cloning from GitHub.
vi.mock('../../src/vault/sync', async () => {
  const index = await buildTestIndex();
  return {
    getVaultManager: () => ({
      getIndex: async () => index,
      peek: () => index,
      refresh: async () => index,
    }),
    __resetVaultManager: () => undefined,
  };
});

import { buildMcpServerForCaller } from '../../src/mcp/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ResolvedCaller } from '../../src/auth/tokens';

beforeAll(() => {
  expect(FIXTURE_ROOT).toBeDefined();
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Send a single JSON-RPC request through a fresh transport, exactly as a real
 * HTTP client would in stateless mode.
 */
async function rpc(caller: ResolvedCaller, body: Record<string, unknown>): Promise<{ status: number; json: JsonRpcResponse | null }> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildMcpServerForCaller(caller);
  await server.connect(transport);
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const res = await transport.handleRequest(req);
  const text = await res.text();
  let json: JsonRpcResponse | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as JsonRpcResponse;
    } catch {
      const m = /data:\s*(\{[\s\S]*?\})\s*(?:\n|$)/m.exec(text);
      if (m) json = JSON.parse(m[1]) as JsonRpcResponse;
    }
  }
  return { status: res.status, json };
}

const publicCaller: ResolvedCaller = {
  token: 'tok_public',
  consumer: { name: 'public-wiki-preview', max_visibility: 'public', rate_limit_per_min: 30 },
};
const internalCaller: ResolvedCaller = {
  token: 'tok_internal',
  consumer: { name: 'paperclip-prod', max_visibility: 'internal', rate_limit_per_min: 60 },
};
const secretCaller: ResolvedCaller = {
  token: 'tok_secret',
  consumer: { name: 'cap-admin', max_visibility: 'secret', rate_limit_per_min: 300 },
};

let idCounter = 0;
function nextId() {
  return ++idCounter;
}

function callTool(caller: ResolvedCaller, name: string, args: Record<string, unknown>) {
  return rpc(caller, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

describe('initialize + tools/list', () => {
  it('initialize returns server info', async () => {
    const { json } = await rpc(publicCaller, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' },
      },
    });
    expect(json?.result.serverInfo.name).toBe('moltbank-kb-mcp');
    expect(json?.result.capabilities.tools).toBeDefined();
  });

  it('tools/list returns our 7 vault tools', async () => {
    const { json } = await rpc(publicCaller, {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/list',
    });
    const names: string[] = json!.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'vault_search',
        'vault_read_file',
        'vault_list_section',
        'vault_get_status',
        'vault_search_todos',
        'vault_list_auto_synced',
        'vault_get_asset_index',
      ])
    );
    expect(names.length).toBe(7);
  });
});

describe('vault_read_file over MCP', () => {
  it('public caller can read a public file', async () => {
    const { json } = await callTool(publicCaller, 'vault_read_file', {
      path: 'wiki/overview/what-is-moltbank.md',
    });
    const struct = json!.result.structuredContent;
    expect(struct.path).toBe('wiki/overview/what-is-moltbank.md');
    expect(struct.frontmatter.visibility).toBe('public');
  });

  it('public caller gets an error for a secret file (no existence leak)', async () => {
    const { json } = await callTool(publicCaller, 'vault_read_file', {
      path: 'wiki/finance/treasury.md',
    });
    expect(json!.result.isError).toBe(true);
  });

  it('secret caller can read the secret file', async () => {
    const { json } = await callTool(secretCaller, 'vault_read_file', {
      path: 'wiki/finance/treasury.md',
    });
    expect(json!.result.structuredContent.frontmatter.visibility).toBe('secret');
  });

  it('rejects path traversal with an error result', async () => {
    const { json } = await callTool(publicCaller, 'vault_read_file', { path: '../outside.md' });
    expect(json!.result.isError).toBe(true);
  });
});

describe('vault_search over MCP', () => {
  it('public caller cannot find secret files', async () => {
    const { json } = await callTool(publicCaller, 'vault_search', { query: 'octopus', limit: 50 });
    const hits = json!.result.structuredContent.hits;
    expect(hits.every((h: any) => h.visibility === 'public')).toBe(true);
    expect(hits.some((h: any) => h.path === 'wiki/finance/treasury.md')).toBe(false);
  });

  it('internal caller finds internal files but not secret ones', async () => {
    const { json } = await callTool(internalCaller, 'vault_search', { query: 'octopus', limit: 50 });
    const hits = json!.result.structuredContent.hits;
    expect(hits.some((h: any) => h.visibility === 'internal')).toBe(true);
    expect(hits.every((h: any) => h.visibility !== 'secret')).toBe(true);
  });
});

describe('vault_list_section over MCP', () => {
  it('visibility-filtered list', async () => {
    const { json } = await callTool(publicCaller, 'vault_list_section', { section: 'wiki' });
    const items = json!.result.structuredContent.items;
    expect(items.every((i: any) => i.visibility === 'public')).toBe(true);
  });
});

describe('vault_search_todos over MCP', () => {
  it('finds [!TODO] markers for internal caller', async () => {
    const { json } = await callTool(internalCaller, 'vault_search_todos', {});
    const todos = json!.result.structuredContent.todos;
    expect(todos.length).toBeGreaterThan(0);
    expect(todos.some((t: any) => t.path === 'wiki/overview/mission.md')).toBe(true);
  });

  it('public caller never sees TODOs from internal/secret files', async () => {
    const { json } = await callTool(publicCaller, 'vault_search_todos', {});
    const todos = json!.result.structuredContent.todos;
    expect(
      todos.every(
        (t: any) => t.path !== 'wiki/product/feature-roadmap.md' && t.path !== 'raw/meeting-notes-2026-04-01.md'
      )
    ).toBe(true);
  });
});

describe('vault_list_auto_synced over MCP', () => {
  it('lists maintained_by=agent entries with stale flag', async () => {
    const { json } = await callTool(internalCaller, 'vault_list_auto_synced', {});
    const entries = json!.result.structuredContent.entries;
    const raw = entries.find((e: any) => e.path === 'raw/meeting-notes-2026-04-01.md');
    expect(raw.stale).toBe(true); // last_synced is null
  });
});

describe('vault_get_asset_index over MCP', () => {
  it('parses the assets-index markdown tables', async () => {
    const { json } = await callTool(publicCaller, 'vault_get_asset_index', {});
    const entries = json!.result.structuredContent.entries;
    expect(entries.length).toBe(3);
    const logo = entries.find((e: any) => e.filename === 'logo-primary.svg');
    expect(logo.category).toBe('logo');
    expect(logo.variants).toEqual(['dark', 'light']);
    expect(logo.size_bytes).toBe(24000);
  });

  it('filters by category', async () => {
    const { json } = await callTool(publicCaller, 'vault_get_asset_index', { category: 'icon' });
    const entries = json!.result.structuredContent.entries;
    expect(entries.length).toBe(1);
    expect(entries[0].filename).toBe('icon.png');
  });
});

describe('vault_get_status over MCP', () => {
  it('summary counts match visible files for the caller', async () => {
    const { json } = await callTool(secretCaller, 'vault_get_status', {});
    const summary = json!.result.structuredContent.summary;
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.complete + summary.partial + summary.stub).toBeLessThanOrEqual(summary.total);
  });

  it('public caller sees fewer files than secret caller', async () => {
    const pub = await callTool(publicCaller, 'vault_get_status', {});
    const sec = await callTool(secretCaller, 'vault_get_status', {});
    expect(pub.json!.result.structuredContent.summary.total).toBeLessThan(
      sec.json!.result.structuredContent.summary.total
    );
  });
});
