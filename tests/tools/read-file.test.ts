import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestIndex } from '../helpers/build-test-index';
import { getFileOrThrow, safeResolvePath } from '../../src/vault/index';
import { callerCanSee } from '../../src/vault/visibility';
import { PathTraversalError, NotFoundError } from '../../src/errors';
import { VaultIndex } from '../../src/vault/types';

let index: VaultIndex;
beforeAll(async () => {
  index = await buildTestIndex();
});

describe('safeResolvePath', () => {
  it('rejects absolute paths', () => {
    expect(() => safeResolvePath(index.rootPath, '/etc/passwd')).toThrow(PathTraversalError);
  });
  it('rejects .. traversal', () => {
    expect(() => safeResolvePath(index.rootPath, '../other/file.md')).toThrow(PathTraversalError);
    expect(() => safeResolvePath(index.rootPath, 'wiki/../../secret.md')).toThrow(PathTraversalError);
  });
  it('rejects NUL bytes', () => {
    expect(() => safeResolvePath(index.rootPath, 'wiki/a.md\0')).toThrow(PathTraversalError);
  });
  it('accepts valid relative paths', () => {
    const p = safeResolvePath(index.rootPath, 'wiki/overview/what-is-moltbank.md');
    expect(p.endsWith('what-is-moltbank.md')).toBe(true);
  });
});

describe('getFileOrThrow', () => {
  it('returns the file for a valid path', () => {
    const f = getFileOrThrow(index, 'wiki/overview/what-is-moltbank.md');
    expect(f.title).toBe('What is MoltBank');
    expect(f.frontmatter.visibility).toBe('public');
  });
  it('throws NotFoundError for a missing file', () => {
    expect(() => getFileOrThrow(index, 'wiki/nope.md')).toThrow(NotFoundError);
  });
  it('throws PathTraversalError for traversal', () => {
    expect(() => getFileOrThrow(index, '../outside.md')).toThrow(PathTraversalError);
  });
});

describe('read-file visibility', () => {
  const secretPath = 'wiki/finance/treasury.md';

  it('internal caller cannot see secret file', () => {
    const file = index.files.get(secretPath);
    expect(file).toBeDefined();
    expect(callerCanSee('internal', file!.frontmatter.visibility)).toBe(false);
  });

  it('public caller cannot see internal file', () => {
    const file = index.files.get('wiki/product/feature-roadmap.md');
    expect(file).toBeDefined();
    expect(callerCanSee('public', file!.frontmatter.visibility)).toBe(false);
  });

  it('secret caller can see secret file', () => {
    const file = index.files.get(secretPath);
    expect(callerCanSee('secret', file!.frontmatter.visibility)).toBe(true);
  });
});
