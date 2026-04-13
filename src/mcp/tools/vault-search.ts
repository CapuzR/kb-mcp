import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { searchVault } from '../../vault/search';
import { logToolCall } from '../../logging';

const inputShape = {
  query: z.string().min(1).max(500).describe('Search phrase'),
  section: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Limit results to files under this path prefix (e.g. "wiki/overview")'),
  status: z
    .enum(['complete', 'partial', 'stub'])
    .optional()
    .describe('Only return files with this status'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max hits to return'),
};

export function registerVaultSearch(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_search',
    {
      title: 'Search the knowledge vault',
      description:
        'Full-text search over the moltbank-kb markdown vault. Results are ranked by title > heading > body matches and filtered to your visibility tier. Frontmatter is excluded from body search.',
      inputSchema: inputShape,
    },
    async (args): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const hits = searchVault(index, {
        query: args.query,
        section: args.section,
        status: args.status,
        limit: args.limit ?? 10,
        callerMax: caller.consumer.max_visibility,
      });
      const payload = { hits };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_search',
        input_size: JSON.stringify(args).length,
        output_size: out.length,
        result_count: hits.length,
        status: 'ok',
        duration_ms: Date.now() - started,
      });
      return {
        content: [{ type: 'text', text: out }],
        structuredContent: payload,
      };
    }
  );
}
