import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import { buildIndex } from './index';
import { VaultIndex } from './types';
import { logError, logInfo } from '../logging';

/**
 * Where on disk we keep the extracted vault. On Vercel only `/tmp` is writable,
 * so we default there; in local dev you can point VAULT_CACHE_DIR anywhere.
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
 * Mint a short-lived installation token from a GitHub App, or fall back to a
 * PAT in GITHUB_TOKEN. Called fresh on every sync so tokens never age out.
 */
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

export interface VaultManagerOptions {
  /** override the fetch-and-extract implementation (for tests) */
  cloneOrPull?: (destAbs: string) => Promise<string>;
  /** override the indexer */
  builder?: (destAbs: string, sha: string) => Promise<VaultIndex>;
}

/**
 * Singleton vault manager. One per process; Vercel lambdas get their own.
 *
 * - cold start → fetch tarball + extract
 * - webhook refresh / admin refresh / TTL expiry → fetch again
 * - every other request → serve from memory
 */
class VaultManager {
  private index: VaultIndex | null = null;
  private inFlight: Promise<VaultIndex> | null = null;
  private cloneOrPull: (destAbs: string) => Promise<string>;
  private builder: (destAbs: string, sha: string) => Promise<VaultIndex>;

  constructor(opts: VaultManagerOptions = {}) {
    this.cloneOrPull = opts.cloneOrPull ?? defaultFetchAndExtract;
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

/**
 * Fetch the latest commit SHA for the configured branch.
 */
async function getLatestSha(owner: string, repo: string, ref: string, token: string): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'moltbank-kb-mcp',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub commits API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { sha?: string };
  if (!body.sha) throw new Error('GitHub commits API returned no sha');
  return body.sha;
}

/**
 * Download and extract the repo tarball for a given ref to `destAbs`.
 * Uses GitHub's /tarball API (pure HTTP, no git binary required on the host).
 */
async function downloadAndExtractTarball(
  owner: string,
  repo: string,
  ref: string,
  destAbs: string,
  token: string
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'moltbank-kb-mcp',
    },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`GitHub tarball API ${res.status}: ${await res.text().catch(() => '')}`);
  }

  // Fresh extraction — wipe prior cache, recreate dir.
  await fs.rm(destAbs, { recursive: true, force: true });
  await fs.mkdir(destAbs, { recursive: true });

  // Web ReadableStream → Node Readable → gunzip → tar extractor.
  // `strip: 1` removes the top-level directory (e.g. "moltbankhq-moltbank-kb-<sha>/").
  const nodeReadable = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream<Uint8Array>);
  const extractor = tar.x({ cwd: destAbs, strip: 1 });
  await pipeline(nodeReadable, createGunzip(), extractor);
}

async function defaultFetchAndExtract(destAbs: string): Promise<string> {
  // Offline mode: treat VAULT_CACHE_DIR as a pre-populated checkout.
  if (process.env.VAULT_OFFLINE_MODE === 'true' || process.env.VAULT_OFFLINE_MODE === '1') {
    await fs.mkdir(destAbs, { recursive: true });
    return 'offline-mode';
  }

  const slug = repoSlug();
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPO value: ${slug}`);
  const ref = branch();
  const token = await resolveAuthToken();

  // Resolve ref → sha first so the index is tagged with a stable identifier
  // (tarball URL returns a redirect; the extracted top-dir contains the sha,
  // but resolving via the commits API is cleaner and one extra cheap call).
  const sha = await getLatestSha(owner, repo, ref, token);
  await downloadAndExtractTarball(owner, repo, sha, destAbs, token);
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

