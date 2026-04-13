import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { getVaultManager } from '../../vault/sync';
import { callerCanSee } from '../../vault/visibility';
import { logToolCall } from '../../logging';

const inputShape = {};

interface AutoSyncedEntry {
  path: string;
  source_repo: string | null;
  source_paths: string[];
  cadence: string | null;
  last_synced: string | null;
  stale: boolean;
}

/**
 * Parse a cadence string like "daily", "hourly", "weekly", or "PT1H"/"P1D"
 * (ISO 8601 durations). Returns expected max age in ms, or null if unknown.
 */
function cadenceToMs(cadence: string | null): number | null {
  if (!cadence) return null;
  const c = cadence.toLowerCase().trim();
  const named: Record<string, number> = {
    minutely: 60_000,
    hourly: 3_600_000,
    daily: 86_400_000,
    weekly: 7 * 86_400_000,
    monthly: 30 * 86_400_000,
  };
  if (c in named) return named[c];
  // ISO 8601 duration: PnDTnHnMnS (very small subset)
  const iso = /^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)?$/i.exec(cadence.trim());
  if (iso) {
    const d = Number(iso[1] ?? 0);
    const h = Number(iso[2] ?? 0);
    const m = Number(iso[3] ?? 0);
    const s = Number(iso[4] ?? 0);
    const total = d * 86_400_000 + h * 3_600_000 + m * 60_000 + s * 1_000;
    return total > 0 ? total : null;
  }
  return null;
}

const GRACE_MS = 2 * 3_600_000; // 2 hours

function computeStale(lastSynced: string | null, cadence: string | null): boolean {
  if (!lastSynced) return true;
  const ts = Date.parse(lastSynced);
  if (!Number.isFinite(ts)) return true;
  const maxAge = cadenceToMs(cadence);
  if (maxAge === null) return false;
  return Date.now() - ts > maxAge + GRACE_MS;
}

export function registerVaultListAutoSynced(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'vault_list_auto_synced',
    {
      title: 'List auto-synced files',
      description:
        'List every file whose `maintained_by: agent`. Returns source repo, source paths, cadence, last_synced, and a computed `stale` flag.',
      inputSchema: inputShape,
    },
    async (): Promise<CallToolResult> => {
      const started = Date.now();
      const index = await getVaultManager().getIndex();
      const entries: AutoSyncedEntry[] = [];

      for (const file of index.files.values()) {
        if (file.frontmatter.maintained_by !== 'agent') continue;
        if (!callerCanSee(caller.consumer.max_visibility, file.frontmatter.visibility)) continue;

        const lastSynced = typeof file.frontmatter.last_synced === 'string' ? file.frontmatter.last_synced : null;
        const cadence = typeof file.frontmatter.cadence === 'string' ? file.frontmatter.cadence : null;

        entries.push({
          path: file.path,
          source_repo: typeof file.frontmatter.source_repo === 'string' ? file.frontmatter.source_repo : null,
          source_paths: Array.isArray(file.frontmatter.source_paths) ? file.frontmatter.source_paths : [],
          cadence,
          last_synced: lastSynced,
          stale: computeStale(lastSynced, cadence),
        });
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      const payload = { entries };
      const out = JSON.stringify(payload);
      logToolCall({
        event: 'tool_call',
        ts: new Date().toISOString(),
        consumer: caller.consumer.name,
        tool: 'vault_list_auto_synced',
        input_size: 2,
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
