import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { listSection } from '../../vault/index';
import { filterByVisibility } from '../../vault/visibility';
import { logToolCall } from '../../logging';

const inputShape = {
  section: z
    .string()
    .min(1)
    .max(200)
    .describe('Path prefix to list, e.g. "wiki" or "wiki/overview"'),
  recursive: z.boolean().default(true).describe('If true, list all descendants; if false, direct children only'),
};

export function registerVaultListSection(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_list_section',
    {
      title: 'List vault section',
      description:
        'List markdown files in a vault section with their frontmatter metadata. Filters by visibility tier.',
      inputSchema: inputShape,
    },
    async ({ section, recursive }): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const files = filterByVisibility(listSection(index, section, recursive ?? true), caller.consumer.max_visibility);
      const items = files.map(f => ({
        path: f.path,
        title: f.title,
        status: f.frontmatter.status ?? null,
        coverage: f.frontmatter.coverage ?? null,
        visibility: f.frontmatter.visibility,
        maintained_by: f.frontmatter.maintained_by ?? null,
        last_updated: f.frontmatter.last_updated ?? null,
      }));
      const payload = { items };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_list_section',
        input_size: JSON.stringify({ section, recursive }).length,
        output_size: out.length,
        result_count: items.length,
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
