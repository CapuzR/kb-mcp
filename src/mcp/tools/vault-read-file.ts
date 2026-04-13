import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { getFileOrThrow } from '../../vault/index';
import { callerCanSee } from '../../vault/visibility';
import { NotFoundError, ForbiddenError, AppError } from '../../errors';
import { logToolCall } from '../../logging';

const inputShape = {
  path: z
    .string()
    .min(1)
    .max(500)
    .describe('Path relative to the vault root, e.g. "wiki/overview/what-is-moltbank.md"'),
};

export function registerVaultReadFile(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_read_file',
    {
      title: 'Read a vault file',
      description:
        'Read a single markdown file from the vault by relative path. Returns parsed frontmatter and the body. Enforces path-traversal and visibility-tier checks.',
      inputSchema: inputShape,
    },
    async ({ path: relPath }): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const index = await getVaultManager().getIndex();
        const file = getFileOrThrow(index, relPath);
        if (!callerCanSee(caller.consumer.max_visibility, file.frontmatter.visibility)) {
          // Do not reveal that the file exists — present as 404 to the caller.
          throw new NotFoundError(`File not found: ${relPath}`);
        }
        const payload = {
          path: file.path,
          frontmatter: file.frontmatter,
          body: file.body,
          related: file.frontmatter.related ?? [],
        };
        const out = JSON.stringify(payload);
        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'vault_read_file',
          input_size: JSON.stringify({ path: relPath }).length,
          output_size: out.length,
          path: file.path,
          status: 'ok',
          duration_ms: Date.now() - started,
        });
        return {
          content: [{ type: 'text', text: out }],
          structuredContent: payload,
        };
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'internal';
        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'vault_read_file',
          input_size: JSON.stringify({ path: relPath }).length,
          path: relPath,
          status: 'error',
          error_code: code,
          duration_ms: Date.now() - started,
        });
        if (err instanceof NotFoundError || err instanceof ForbiddenError || err instanceof AppError) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );
}
