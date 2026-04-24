import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { getFileOrThrow } from '../../vault/index';
import { ForbiddenError, AppError, NotFoundError } from '../../errors';
import { logToolCall } from '../../logging';

const STATUS_VALUES = ['pending', 'applied', 'flagged', 'rejected', 'noted', 'cancelled'] as const;

const inputShape = {
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe('Filter by entry status. Omit to get all entries.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max entries to return (default 50, most recent first).'),
};

interface ParsedEntry {
  timestamp: string;
  title: string;
  target: string | null;
  type: string | null;
  reason: string | null;
  status: string | null;
  reviewerNotes: string | null;
}

/**
 * Lightweight parser for temp/<owner>.md entries. Intentionally does NOT
 * parse the content block — agents get structured metadata, not payloads
 * (they can fetch the file if they need the raw content). Matches the
 * parser in code/reconcile-temp.mjs at the entry-header level.
 */
function parseEntries(body: string): ParsedEntry[] {
  const lines = body.split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  let current: ParsedEntry | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const raw of lines) {
    const header = raw.match(/^###\s+(.+?)\s*\|\s*(.+?)\s*$/);
    if (header) {
      flush();
      current = {
        timestamp: header[1].trim(),
        title: header[2].trim(),
        target: null,
        type: null,
        reason: null,
        status: null,
        reviewerNotes: null,
      };
      continue;
    }
    if (!current) continue;
    const field = raw.match(/^\s*-\s*\*\*([\w-]+):\*\*\s*(.*)$/);
    if (!field) continue;
    const [, k, v] = field;
    if (k === 'target') current.target = v.trim() || null;
    else if (k === 'type') current.type = v.trim() || null;
    else if (k === 'reason') current.reason = v.trim() || null;
    else if (k === 'status') current.status = v.trim() || null;
    else if (k === 'reviewer-notes') current.reviewerNotes = v.trim() || null;
  }
  flush();
  return entries;
}

export function registerTempListMyEntries(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'temp_list_my_entries',
    {
      title: "List your own /temp entries",
      description:
        "Return the entries in your own temp/<owner>.md. Read-only; cannot see other owners' files. Filter by status and limit.",
      inputSchema: inputShape,
    },
    async ({ status, limit }): Promise<CallToolResult> => {
      const started = Date.now();
      const owner = caller.consumer.owner;
      try {
        if (!owner) {
          throw new ForbiddenError(
            'temp_list_my_entries requires a token with an `owner` field'
          );
        }
        const path = `temp/${owner}.md`;
        const index = await getVaultManager().getIndex();
        let entries: ParsedEntry[];
        try {
          const file = getFileOrThrow(index, path);
          entries = parseEntries(file.body);
        } catch (err) {
          if (err instanceof NotFoundError) {
            entries = [];
          } else {
            throw err;
          }
        }
        if (status) entries = entries.filter((e) => e.status === status);
        // Reverse so most-recent is first (entries are appended chronologically).
        const sorted = entries.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const truncated = sorted.slice(0, limit);

        const payload = {
          owner,
          file: path,
          total: entries.length,
          returned: truncated.length,
          entries: truncated,
        };
        const out = JSON.stringify(payload);
        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'temp_list_my_entries',
          input_size: JSON.stringify({ status, limit }).length,
          output_size: out.length,
          path,
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
          tool: 'temp_list_my_entries',
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
