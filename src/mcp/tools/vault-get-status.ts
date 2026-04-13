import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { callerCanSee } from '../../vault/visibility';
import { Status, VaultFile } from '../../vault/types';
import { logToolCall } from '../../logging';

const inputShape = {};

interface StatusRow {
  path: string;
  status: Status | null;
  coverage: string | number | null;
  visibility: string;
  maintained_by: string | null;
  missing_count: number;
}

function countTodos(body: string): number {
  const re = /\[!TODO[^\]]*\]/gi;
  let count = 0;
  while (re.exec(body)) count++;
  return count;
}

export function registerVaultGetStatus(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_get_status',
    {
      title: 'Vault status snapshot',
      description:
        'Return a compact snapshot of every file visible to you: path, status, coverage, maintainer, and outstanding [!TODO] count. Also returns a summary count by status.',
      inputSchema: inputShape,
    },
    async (): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const rows: StatusRow[] = [];
      const summary = { complete: 0, partial: 0, stub: 0, total: 0 };

      for (const file of index.files.values()) {
        if (!callerCanSee(caller.consumer.max_visibility, file.frontmatter.visibility)) continue;
        const status = file.frontmatter.status ?? null;
        if (status === 'complete') summary.complete++;
        else if (status === 'partial') summary.partial++;
        else if (status === 'stub') summary.stub++;
        summary.total++;

        rows.push({
          path: file.path,
          status,
          coverage: file.frontmatter.coverage ?? null,
          visibility: file.frontmatter.visibility,
          maintained_by: file.frontmatter.maintained_by ?? null,
          missing_count: countTodos(file.body),
        });
      }

      rows.sort((a, b) => a.path.localeCompare(b.path));
      const payload = { files: rows, summary };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_get_status',
        input_size: 2,
        output_size: out.length,
        result_count: rows.length,
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

// Keep a reference so TS doesn't flag the generic import as unused in some setups.
export type _StatusRowExport = StatusRow;
export type _VaultFileExport = VaultFile;
