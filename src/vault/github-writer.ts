/**
 * GitHub-backed writer for kb-mcp.
 *
 * All write paths in this file are NARROWLY SCOPED by design: no caller input
 * ever flows into the file path passed to the GitHub Contents API. The only
 * writable paths are the four per-owner staging files:
 *
 *   temp/cap.md
 *   temp/jesus.md
 *   temp/daniel.md
 *   temp/marielba.md
 *
 * The path is derived exclusively from the server-side `owner` field on the
 * authenticated caller. If that field is missing, no write is performed.
 *
 * This module is the only surface in kb-mcp that ever holds a GitHub token
 * with `contents:write` scope — every other read path uses the same creds
 * but via `getContent`/tarball. If someone extends this file to accept a
 * caller-supplied path, they must also extend `temp/README.md`, the rollout
 * plan in `wiki/ops/mcp-write-enforcement-plan.md`, and the GitHub Actions
 * path-scope check — the scoping assumption is load-bearing.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Owner, OWNER_VALUES } from '../auth/tokens';
import { AppError, ForbiddenError } from '../errors';

function commitAuthor(): { name: string; email: string } {
  return {
    name: process.env.MCP_COMMIT_AUTHOR_NAME ?? 'kb-mcp-bot',
    email: process.env.MCP_COMMIT_AUTHOR_EMAIL ?? 'bot@moltbank.bot',
  };
}

function repoSlug(): { owner: string; repo: string } {
  const slug = process.env.GITHUB_REPO || 'moltbankhq/moltbank-kb';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new AppError('internal', `Invalid GITHUB_REPO value: ${slug}`, 500);
  }
  return { owner, repo };
}

function branch(): string {
  return process.env.GITHUB_BRANCH || 'main';
}

/**
 * Mint an Octokit instance authenticated as the kb-mcp GitHub App install.
 * Falls back to a PAT if the App env vars are not set (for local dev).
 * The token minted here has whatever scope the App install grants —
 * production installs should have `contents: write` on moltbankhq/moltbank-kb.
 */
async function getOctokit(): Promise<Octokit> {
  const appId = process.env.GITHUB_APP_ID;
  const instId = process.env.GITHUB_APP_INSTALLATION_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId && instId && pem) {
    const auth = createAppAuth({
      appId,
      privateKey: pem.replace(/\\n/g, '\n'),
      installationId: Number(instId),
    });
    const result = await auth({ type: 'installation' });
    return new Octokit({ auth: result.token });
  }
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return new Octokit({ auth: pat });
  throw new AppError('internal', 'No GitHub credentials configured', 500);
}

/**
 * Load the current content + sha of a /temp file. Returns null content if
 * the file does not exist yet (first write will create it).
 */
async function getTempFile(owner: Owner): Promise<{ content: string; sha: string | null }> {
  if (!OWNER_VALUES.includes(owner)) {
    // This is an internal invariant; a caller that bypasses resolveCaller
    // should never reach here. Treat as forbidden.
    throw new ForbiddenError(`Unknown owner: ${owner}`);
  }
  const path = `temp/${owner}.md`;
  const { owner: repoOwner, repo } = repoSlug();
  const octokit = await getOctokit();

  try {
    const res = await octokit.rest.repos.getContent({
      owner: repoOwner,
      repo,
      path,
      ref: branch(),
    });
    // getContent returns an array for dirs; we expect a file.
    if (Array.isArray(res.data) || res.data.type !== 'file') {
      throw new AppError('internal', `Expected file at ${path}, got directory`, 500);
    }
    const content = Buffer.from(res.data.content, res.data.encoding as BufferEncoding).toString('utf8');
    return { content, sha: res.data.sha };
  } catch (err: unknown) {
    // 404 -> file doesn't exist yet; caller can create it.
    const status = (err as { status?: number })?.status;
    if (status === 404) return { content: '', sha: null };
    throw err;
  }
}

/**
 * Write (create or update) a /temp/<owner>.md file on the configured branch.
 * The path is derived SOLELY from `owner`, which must be one of OWNER_VALUES.
 * No caller-supplied string is ever interpolated into the path.
 */
async function putTempFile(
  owner: Owner,
  nextContent: string,
  sha: string | null,
  commitMessage: string
): Promise<string> {
  if (!OWNER_VALUES.includes(owner)) {
    throw new ForbiddenError(`Unknown owner: ${owner}`);
  }
  const path = `temp/${owner}.md`;
  const { owner: repoOwner, repo } = repoSlug();
  const octokit = await getOctokit();

  const author = commitAuthor();
  const res = await octokit.rest.repos.createOrUpdateFileContents({
    owner: repoOwner,
    repo,
    path,
    message: commitMessage,
    content: Buffer.from(nextContent, 'utf8').toString('base64'),
    branch: branch(),
    ...(sha ? { sha } : {}),
    committer: author,
    author,
  });
  if (!res.data.commit.sha) {
    throw new AppError('internal', 'GitHub returned no commit sha', 500);
  }
  return res.data.commit.sha;
}

/**
 * Public API: append an entry to the caller's /temp/<owner>.md file.
 *
 * `entry` is the already-formatted markdown block (H3 header + fields +
 * fenced content). We find the `## Entries` section and append the block
 * after the last child of that section; if the section is missing, we
 * append it at the end of the file.
 *
 * Returns the commit sha and the entry identifier (timestamp slug).
 */
export async function appendTempEntry(params: {
  owner: Owner;
  entryMarkdown: string;
  entryId: string;
  commitSummary: string;
}): Promise<{ commit_sha: string; file: string; entry_id: string }> {
  const { owner, entryMarkdown, entryId, commitSummary } = params;

  const { content: current, sha } = await getTempFile(owner);

  let next: string;
  if (!current) {
    // First write — initialize the file with the required shell.
    const now = new Date().toISOString().slice(0, 10);
    next =
      `---\n` +
      `title: ${capitalize(owner)}'s Staging Notes\n` +
      `owner: ${capitalize(owner)}\n` +
      `last_reconciled: never\n` +
      `last_updated: ${now}\n` +
      `---\n\n` +
      `# ${capitalize(owner)}'s Staging Notes\n\n` +
      `Proposed changes to the wiki, pending reconciliation by \`code/reconcile-temp.mjs\`. See [README.md](README.md) for the entry schema, owner scopes, and reconciler behavior.\n\n` +
      `## Entries\n\n` +
      entryMarkdown +
      (entryMarkdown.endsWith('\n') ? '' : '\n');
  } else {
    next = insertUnderEntriesSection(current, entryMarkdown);
  }

  const commit_sha = await putTempFile(owner, next, sha, commitSummary);
  return { commit_sha, file: `temp/${owner}.md`, entry_id: entryId };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Insert `entry` under the `## Entries` heading of `content`. If the heading
 * is missing, append `## Entries\n\n<entry>` at the end. Replaces the
 * placeholder `_No entries yet._` paragraph if present.
 */
function insertUnderEntriesSection(content: string, entry: string): string {
  const entriesRegex = /^## Entries\s*$/m;
  const match = entriesRegex.exec(content);
  const entryBlock = entry.endsWith('\n') ? entry : `${entry}\n`;

  if (!match) {
    const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${sep}## Entries\n\n${entryBlock}`;
  }

  const after = match.index + match[0].length;
  const tail = content.slice(after);
  // Strip a single leading placeholder if present.
  const placeholderRe = /^\n+_No entries yet\._\s*/;
  const tailStripped = tail.replace(placeholderRe, '\n\n');
  return content.slice(0, after) + tailStripped + entryBlock;
}
