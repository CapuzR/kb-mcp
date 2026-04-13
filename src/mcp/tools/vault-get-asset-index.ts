import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { callerCanSee } from '../../vault/visibility';
import { logToolCall } from '../../logging';

const ASSET_INDEX_PATH = 'wiki/assets/assets-index.md';

const inputShape = {
  category: z.string().min(1).max(100).optional().describe('Filter to assets in this category'),
};

interface AssetEntry {
  path_or_url: string;
  filename: string;
  category: string | null;
  description: string | null;
  format: string | null;
  size_bytes: number | null;
  variants: string[];
}

/**
 * Parse markdown tables in the assets-index file. Supports any column
 * ordering as long as a header row names the columns. Column names we
 * look for (case-insensitive):
 *   path, url, filename, category, description, format, size, variants
 */
function parseMarkdownTables(body: string): Array<Record<string, string>> {
  const lines = body.split(/\r?\n/);
  const rows: Array<Record<string, string>> = [];

  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (header && sep && /^\s*\|.*\|\s*$/.test(header) && /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|\s*$/.test(sep)) {
      const headerCells = header
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(c => c.trim().toLowerCase());
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(c => c.trim());
        const row: Record<string, string> = {};
        for (let c = 0; c < headerCells.length; c++) {
          row[headerCells[c]] = cells[c] ?? '';
        }
        rows.push(row);
        i++;
      }
    } else {
      i++;
    }
  }
  return rows;
}

function parseSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = unit === 'gb' ? 1_000_000_000 : unit === 'mb' ? 1_000_000 : unit === 'kb' ? 1_000 : 1;
  return Math.round(n * mult);
}

function rowToEntry(row: Record<string, string>): AssetEntry | null {
  const pathOrUrl = row.path || row.url || row['path_or_url'] || row.file || '';
  if (!pathOrUrl) return null;
  const filename = row.filename || pathOrUrl.split(/[\\/]/).pop() || pathOrUrl;
  const variantsRaw = row.variants || '';
  const variants = variantsRaw
    ? variantsRaw
        .split(/[,;]/)
        .map(v => v.trim())
        .filter(Boolean)
    : [];
  return {
    path_or_url: pathOrUrl,
    filename,
    category: row.category || null,
    description: row.description || null,
    format: row.format || null,
    size_bytes: parseSize(row.size),
    variants,
  };
}

export function registerVaultGetAssetIndex(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_get_asset_index',
    {
      title: 'Get the asset index',
      description:
        'Parse `wiki/assets/assets-index.md` into structured asset records. Optionally filter by category.',
      inputSchema: inputShape,
    },
    async ({ category }): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const file = index.files.get(ASSET_INDEX_PATH);
      let entries: AssetEntry[] = [];
      let note: string | undefined;

      if (!file) {
        note = `${ASSET_INDEX_PATH} does not exist yet; returning empty list.`;
      } else if (!callerCanSee(caller.consumer.max_visibility, file.frontmatter.visibility)) {
        note = `${ASSET_INDEX_PATH} exists but is not visible to your tier.`;
      } else {
        const rows = parseMarkdownTables(file.body);
        entries = rows.map(rowToEntry).filter((e): e is AssetEntry => e !== null);
        if (category) {
          const needle = category.toLowerCase();
          entries = entries.filter(e => (e.category ?? '').toLowerCase() === needle);
        }
      }

      const payload = { entries, ...(note ? { note } : {}) };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_get_asset_index',
        input_size: JSON.stringify({ category }).length,
        output_size: out.length,
        result_count: entries.length,
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
