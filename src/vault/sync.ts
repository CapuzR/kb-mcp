import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';
import { buildIndex } from './index';
import { VaultIndex } from './types';
import { logError, logInfo } from '../logging';

/**
 * Where on disk we keep the clone. On Vercel only `/tmp` is writable, so we
 * default there; in local dev you can point VAULT_CACHE_DIR anywhere.
 */
function cacheDir(): string {
  return process.env.VAULT_CACHE_DIR || '/tmp/moltbank-kb';
}

function repoSlug(): string {
  return process.env.GITHUB_REPO || 'moltbankhq/moltbank-kb';
}

function branch(): string {
  return process.env.GITHUB_BRANCH || 'main';
}

function ttlSeconds(): number {
  const raw = Number(process.env.CACHE_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

/**
 * Get an HTTPS URL with an auth token embedded. Prefer GitHub App installation
 * token, fall back to a PAT in GITHUB_TOKEN.
 */
async function getAuthedCloneUrl(): Promise<string> {
  const slug = repoSlug();
  const token = await resolveAuthToken();
  // x-access-token is the convention for app install tokens; works for PATs too
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${slug}.git`;
}

async function resolveAuthToken(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const instId = process.env.GITHUB_APP_INSTALLATION_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId && instId && pem) {
    // Lazy import so local dev without the GH App env vars stays lean
    const { createAppAuth } = await import('@octokit/auth-app');
    const auth = createAppAuth({
      appId,
      privateKey: pem.replace(/\\n/g, '\n'),
      installationId: Number(instId),
    });
    const result = await auth({ type: 'installation' });
    return result.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return pat;
  throw new Error(
    'No GitHub credentials configured. Set either GITHUB_APP_ID+GITHUB_APP_INSTALLATION_ID+GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN.'
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface SyncResult {
  index: VaultIndex;
  /** true if we re-fetched from GitHub this call */
  refetched: boolean;
}

export interface VaultManagerOptions {
  /** override the clone/pull implementation (for tests) */
  cloneOrPull?: (destAbs: string) => Promise<string>;
  /** override the indexer */
  builder?: (destAbs: string, sha: string) => Promise<VaultIndex>;
}

/**
 * Singleton vault manager. One per process; Vercel lambdas get their own.
 *
 * - cold start → clone
 * - webhook refresh / admin refresh / TTL expiry → pull
 * - every other request → serve from memory
 */
class VaultManager {
  private index: VaultIndex | null = null;
  private inFlight: Promise<VaultIndex> | null = null;
  private cloneOrPull: (destAbs: string) => Promise<string>;
  private builder: (destAbs: string, sha: string) => Promise<VaultIndex>;

  constructor(opts: VaultManagerOptions = {}) {
    this.cloneOrPull = opts.cloneOrPull ?? defaultCloneOrPull;
    this.builder = opts.builder ?? buildIndex;
  }

  async getIndex(): Promise<VaultIndex> {
    if (this.index && !this.isExpired(this.index)) return this.index;
    return this.refresh();
  }

  async refresh(): Promise<VaultIndex> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const dest = cacheDir();
        const sha = await this.cloneOrPull(dest);
        const idx = await this.builder(dest, sha);
        this.index = idx;
        logInfo({
          event: 'vault_refreshed',
          ts: new Date().toISOString(),
          sha,
          indexed_files: idx.files.size,
        });
        return idx;
      } catch (err) {
        logError({
          event: 'vault_refresh_failed',
          ts: new Date().toISOString(),
          error: (err as Error).message,
        });
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  peek(): VaultIndex | null {
    return this.index;
  }

  private isExpired(idx: VaultIndex): boolean {
    return Date.now() - idx.builtAt > ttlSeconds() * 1000;
  }
}

async function defaultCloneOrPull(destAbs: string): Promise<string> {
  // Offline mode for local dev: treat VAULT_CACHE_DIR as a pre-populated
  // checkout and skip GitHub entirely. Useful for testing against a local
  // clone without configuring a PAT / App install.
  if (process.env.VAULT_OFFLINE_MODE === 'true' || process.env.VAULT_OFFLINE_MODE === '1') {
    await fs.mkdir(destAbs, { recursive: true });
    return 'offline-mode';
  }
  const url = await getAuthedCloneUrl();
  const br = branch();
  const gitDirExists = await exists(path.join(destAbs, '.git'));

  const git: SimpleGit = simpleGit();
  if (!gitDirExists) {
    // Ensure parent exists
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    // Remove any partial dir
    if (await exists(destAbs)) await fs.rm(destAbs, { recursive: true, force: true });
    await git.clone(url, destAbs, ['--depth=1', '--branch', br, '--single-branch']);
  } else {
    const repoGit = simpleGit(destAbs);
    // Reset the origin to use the freshly-minted token (tokens rotate)
    await repoGit.remote(['set-url', 'origin', url]);
    await repoGit.fetch(['--depth=1', 'origin', br]);
    await repoGit.reset(['--hard', `origin/${br}`]);
  }

  const repoGit = simpleGit(destAbs);
  const sha = (await repoGit.revparse(['HEAD'])).trim();
  return sha;
}

// module-level singleton
let manager: VaultManager | null = null;

export function getVaultManager(opts?: VaultManagerOptions): VaultManager {
  if (!manager) manager = new VaultManager(opts);
  return manager;
}

/** Reset the singleton. For tests only. */
export function __resetVaultManager(opts?: VaultManagerOptions): VaultManager {
  manager = new VaultManager(opts);
  return manager;
}
