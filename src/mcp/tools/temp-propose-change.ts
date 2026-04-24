import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { appendTempEntry } from '../../vault/github-writer';
import { ForbiddenError, AppError } from '../../errors';
import { logToolCall } from '../../logging';

const TYPE_VALUES = [
  'add-todo-answer',
  'update-content',
  'update-frontmatter',
  'add-section',
  'note',
] as const;

const MAX_CONTENT_BYTES = 50 * 1024; // 50 KB
const MAX_REASON_CHARS = 500;

const inputShape = {
  type: z.enum(TYPE_VALUES).describe(
    'The kind of proposed change. `note` does not require a target; all other types do.'
  ),
  target: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Target wiki path, e.g. 'wiki/customers/pipeline.md'. Required unless type is 'note'."
    ),
  reason: z
    .string()
    .min(1)
    .max(MAX_REASON_CHARS)
    .describe('One-line justification for the proposed change.'),
  content: z
    .string()
    .min(1)
    .describe(
      'The proposed change payload, as raw markdown (or a `<old>---new---<new>` block for update-content).'
    ),
};

function validateTarget(target: string | undefined, type: string): string | null {
  if (type === 'note') return null;
  if (!target) {
    throw new AppError('invalid_input', `target is required for type=${type}`, 400);
  }
  // Path sanity: no traversal, no absolute, must start with wiki/ for
  // every type that touches the knowledge vault.
  if (target.includes('..') || target.startsWith('/') || target.includes('\0')) {
    throw new AppError('path_traversal', 'target contains unsafe characters', 400);
  }
  if (!target.startsWith('wiki/')) {
    throw new AppError(
      'invalid_input',
      "target must start with 'wiki/' (temp/ writes happen automatically via the MCP tool)",
      400
    );
  }
  return target;
}

function buildEntryMarkdown(params: {
  timestamp: string;
  title: string;
  target: string | null;
  type: string;
  reason: string;
  content: string;
}): string {
  const { timestamp, title, target, type, reason, content } = params;
  const lines: string[] = [];
  lines.push(`### ${timestamp} | ${title}`);
  lines.push('');
  if (target) lines.push(`- **target:** ${target}`);
  lines.push(`- **type:** ${type}`);
  lines.push(`- **reason:** ${reason}`);
  lines.push(`- **status:** pending`);
  lines.push(`- **reviewer-notes:**`);
  lines.push(`- **content:**`);
  // Use a fence that won't collide with content. Triple-backtick is the
  // convention; if the content itself contains ``` we bump to four.
  const fence = content.includes('```') ? '````' : '```';
  lines.push(`  ${fence}`);
  for (const line of content.split(/\r?\n/)) {
    lines.push(`  ${line}`);
  }
  lines.push(`  ${fence}`);
  lines.push('');
  return lines.join('\n');
}

function deriveTitle(type: string, target: string | null, reason: string): string {
  if (type === 'note') return reason.slice(0, 80);
  const short = reason.length > 60 ? reason.slice(0, 57) + '…' : reason;
  return `${type} on ${target ?? '(no target)'} — ${short}`;
}

export function registerTempProposeChange(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'temp_propose_change',
    {
      title: 'Propose a wiki change (appends to your /temp file)',
      description:
        "Append a structured proposal to your own temp/<owner>.md. The tool hard-scopes writes to the caller's owner file only. See temp/README.md for the entry schema and reconciler flow.",
      inputSchema: inputShape,
    },
    async ({ type, target, reason, content }): Promise<CallToolResult> => {
      const started = Date.now();
      const owner = caller.consumer.owner;
      try {
        if (!owner) {
          throw new ForbiddenError(
            'temp_propose_change requires a token with an `owner` field (cap|jesus|daniel|marielba)'
          );
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
          throw new AppError(
            'invalid_input',
            `content exceeds ${MAX_CONTENT_BYTES} bytes`,
            400
          );
        }
        const validTarget = validateTarget(target, type);
        const timestamp = new Date().toISOString();
        const title = deriveTitle(type, validTarget, reason);
        const entryMarkdown = buildEntryMarkdown({
          timestamp,
          title,
          target: validTarget,
          type,
          reason,
          content,
        });

        const commitSummary =
          `[agent-mcp] temp/${owner}: ${caller.consumer.name} proposed ${type}` +
          (validTarget ? ` for ${validTarget}` : '');

        const result = await appendTempEntry({
          owner,
          entryMarkdown,
          entryId: timestamp,
          commitSummary,
        });

        const payload = {
          timestamp,
          owner,
          file: result.file,
          entry_id: result.entry_id,
          commit_sha: result.commit_sha,
        };
        const out = JSON.stringify(payload);

        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'temp_propose_change',
          input_size: JSON.stringify({ type, target, reason, content_length: content.length }).length,
          output_size: out.length,
          path: result.file,
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
          tool: 'temp_propose_change',
          input_size: JSON.stringify({ type, target, reason }).length,
          status: 'error',
          error_code: code,
          duration_ms: Date.now() - started,
        });
        if (err instanceof AppError || err instanceof ForbiddenError) {
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
