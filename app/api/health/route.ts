import { getVaultManager } from '@/vault/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STARTED_AT = Date.now();

export async function GET(): Promise<Response> {
  const manager = getVaultManager();
  const idx = manager.peek();
  const body = {
    status: 'ok',
    vault_sha: idx?.sha ?? null,
    indexed_files: idx?.files.size ?? 0,
    last_synced_at: idx ? new Date(idx.builtAt).toISOString() : null,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
  };
  return Response.json(body);
}
