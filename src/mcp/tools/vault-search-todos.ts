import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { callerCanSee } from '../../vault/visibility';
import { logToolCall } from '../../logging';

const inputShape = {
  owner: z.string().min(1).max(100).optional().describe('Filter by owner label (maintained_by or TODO owner tag)'),
  section: z.string().min(1).max(200).optional().describe('Limit to files under this section prefix'),
  limit: z.number().int().min(1).max(500).default(100).describe('Max TODOs to return'),
};

interface TodoHit {
  path: string;
  label: string;
  question: string;
  owner: string | null;
  suggested_source: string | null;
}

/**
 * Matches our [!TODO] markers. Supported shapes (from the vault conventions):
 *   [!TODO] text here
 *   [!TODO(owner)] text here
 *   [!TODO(owner, source=foo)] text here
 *   [!TODO: source=foo] text here
 *
 * The block of marker+text extends to the end of the line or paragraph.
 */
const TODO_RE = /\[!TODO(?:\(([^)]*)\))?(?::\s*([^\]]*))?\]\s*([^\n]*)/gi;

function parseOwnerBlock(raw: string | undefined): { owner: string | null; source: string | null } {
  if (!raw) return { owner: null, source: null };
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  let owner: string | null = null;
  let source: string | null = null;
  for (const p of parts) {
    const m = /^([A-Za-z0-9_-]+)=(.*)$/.exec(p);
    if (m && m[1].toLowerCase() === 'source') source = m[2];
    else if (!owner) owner = p;
  }
  return { owner, source };
}

function parseInlineKV(raw: string | undefined): { source: string | null } {
  if (!raw) return { source: null };
  const m = /source=([^\s\],]+)/.exec(raw);
  return { source: m ? m[1] : null };
}

export function registerVaultSearchTodos(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_search_todos',
    {
      title: 'List outstanding [!TODO] markers',
      description:
        'Return every [!TODO] marker in the vault, with optional filters by owner or section. Visibility-filtered.',
      inputSchema: inputShape,
    },
    async ({ owner, section, limit }): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const sectionPrefix = section?.replace(/\\/g, '/').replace(/\/+$/, '') ?? null;
      const hits: TodoHit[] = [];
      const cap = limit ?? 100;

      for (const file of index.files.values()) {
        if (!callerCanSee(caller.consumer.max_visibility, file.frontmatter.visibility)) continue;
        if (sectionPrefix && file.path !== sectionPrefix && !file.path.startsWith(sectionPrefix + '/')) continue;

        TODO_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TODO_RE.exec(file.body)) !== null) {
          const block = parseOwnerBlock(m[1]);
          const inline = parseInlineKV(m[2]);
          const todoOwner = block.owner ?? (file.frontmatter.maintained_by ?? null);
          if (owner && todoOwner !== owner) continue;
          hits.push({
            path: file.path,
            label: m[0].trim(),
            question: m[3].trim(),
            owner: todoOwner,
            suggested_source: block.source ?? inline.source,
          });
          if (hits.length >= cap) break;
        }
        if (hits.length >= cap) break;
      }

      const payload = { todos: hits };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_search_todos',
        input_size: JSON.stringify({ owner, section, limit }).length,
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
