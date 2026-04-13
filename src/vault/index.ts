import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { Frontmatter, VaultFile, VaultIndex, Visibility } from './types';
import { isVisibilityTier } from './visibility';
import { PathTraversalError, NotFoundError } from '../errors';

/**
 * Recursively walk a directory, returning all markdown file paths (absolute).
 * Follows real paths only — symlinks inside the vault root are resolved, and
 * any that escape the root are skipped.
 */
async function walkMarkdown(rootAbs: string, subPath = ''): Promise<string[]> {
  const dir = path.join(rootAbs, subPath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    // skip dotfiles and node_modules / .git
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const nextRel = subPath ? `${subPath}/${entry.name}` : entry.name;
    const nextAbs = path.join(rootAbs, nextRel);

    // Reject anything whose real path escapes the root (symlink defense)
    const real = await fs.realpath(nextAbs).catch(() => null);
    if (!real) continue;
    const realRoot = await fs.realpath(rootAbs);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) continue;

    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(rootAbs, nextRel)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(nextRel.split(path.sep).join('/'));
    }
  }
  return files;
}

/**
 * Normalize frontmatter into our typed shape. Missing/invalid `visibility`
 * defaults to `internal` (fail-closed relative to `public`): the vault's
 * convention is to mark every file, so anything without a tier is a bug —
 * we surface it by denying public callers.
 */
function normalizeFrontmatter(raw: Record<string, unknown>): Frontmatter {
  const vis: Visibility = isVisibilityTier(raw.visibility) ? raw.visibility : 'internal';
  const fm: Frontmatter = {
    ...raw,
    visibility: vis,
  };
  if (typeof raw.title === 'string') fm.title = raw.title;
  if (raw.status === 'complete' || raw.status === 'partial' || raw.status === 'stub') {
    fm.status = raw.status;
  }
  if (Array.isArray(raw.related)) {
    fm.related = raw.related.filter((r): r is string => typeof r === 'string');
  }
  if (Array.isArray(raw.source_paths)) {
    fm.source_paths = raw.source_paths.filter((s): s is string => typeof s === 'string');
  }
  return fm;
}

function deriveTitle(fm: Frontmatter, body: string, relPath: string): string {
  if (fm.title && fm.title.trim()) return fm.title.trim();
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec(body);
  if (h1) return h1[1].trim();
  return path.basename(relPath, '.md');
}

export async function buildIndex(rootAbs: string, sha: string): Promise<VaultIndex> {
  const realRoot = await fs.realpath(rootAbs);
  const relPaths = await walkMarkdown(realRoot);
  const files = new Map<string, VaultFile>();

  for (const rel of relPaths) {
    const abs = path.join(realRoot, rel);
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      // Skip files with broken frontmatter rather than failing the whole build.
      continue;
    }
    const fm = normalizeFrontmatter((parsed.data ?? {}) as Record<string, unknown>);
    const body = parsed.content;
    const title = deriveTitle(fm, body, rel);
    files.set(rel, {
      path: rel,
      title,
      frontmatter: fm,
      body,
      bodyLower: body.toLowerCase(),
    });
  }

  return { sha, rootPath: realRoot, files, builtAt: Date.now() };
}

/**
 * Safely resolve a caller-provided relative path against the vault root.
 * Rejects absolute paths, traversal, and anything that would land outside root.
 */
export function safeResolvePath(rootAbs: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new PathTraversalError('Path must be a non-empty string');
  }
  // Reject NUL bytes and absolute paths up front
  if (userPath.includes('\0')) throw new PathTraversalError('Null byte in path');
  if (path.isAbsolute(userPath)) throw new PathTraversalError('Absolute paths not allowed');

  // Normalize and reject any ".." segments
  const normalized = path.posix.normalize(userPath.replace(/\\/g, '/'));
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
    throw new PathTraversalError('Traversal not allowed');
  }

  const resolved = path.resolve(rootAbs, normalized);
  const rootResolved = path.resolve(rootAbs);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new PathTraversalError('Resolved path escapes vault root');
  }
  return resolved;
}

export function getFileOrThrow(index: VaultIndex, userPath: string): VaultFile {
  // validate the path shape first
  safeResolvePath(index.rootPath, userPath);
  // use posix-form path as the key
  const key = userPath.replace(/\\/g, '/');
  const file = index.files.get(key);
  if (!file) {
    throw new NotFoundError(`File not found: ${key}`);
  }
  return file;
}

/** List files whose path begins with a given section prefix. */
export function listSection(index: VaultIndex, section: string, recursive = true): VaultFile[] {
  const prefix = section.replace(/\\/g, '/').replace(/\/+$/, '');
  const results: VaultFile[] = [];
  for (const file of index.files.values()) {
    if (!file.path.startsWith(prefix + '/') && file.path !== prefix) continue;
    if (!recursive) {
      const rest = file.path.slice(prefix.length + 1);
      if (rest.includes('/')) continue;
    }
    results.push(file);
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}
