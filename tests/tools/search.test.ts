import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestIndex } from '../helpers/build-test-index';
import { searchVault } from '../../src/vault/search';
import { VaultIndex } from '../../src/vault/types';

let index: VaultIndex;
beforeAll(async () => {
  index = await buildTestIndex();
});

describe('searchVault', () => {
  it('ranks title hits above body hits', () => {
    const hits = searchVault(index, {
      query: 'octopus',
      limit: 10,
      callerMax: 'secret',
    });
    expect(hits.length).toBeGreaterThan(0);
    // octopus-reference.md has it in the title; it should rank #1
    expect(hits[0].path).toBe('wiki/octopus-reference.md');
  });

  it('excludes frontmatter from body matches (search for "cadence" should not hit files lacking body mentions)', () => {
    // The word "cadence" appears in frontmatter of several files but nowhere
    // in any body. Search should find none.
    const hits = searchVault(index, {
      query: 'cadence',
      limit: 10,
      callerMax: 'secret',
    });
    expect(hits.length).toBe(0);
  });

  it('respects the limit', () => {
    const hits = searchVault(index, {
      query: 'moltbank',
      limit: 1,
      callerMax: 'secret',
    });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('never returns files above the callers tier', () => {
    const hitsPublic = searchVault(index, {
      query: 'octopus',
      limit: 50,
      callerMax: 'public',
    });
    // treasury (secret) and feature-roadmap (internal) both mention octopus;
    // a public caller must see neither.
    expect(hitsPublic.some(h => h.path === 'wiki/finance/treasury.md')).toBe(false);
    expect(hitsPublic.some(h => h.path === 'wiki/product/feature-roadmap.md')).toBe(false);
  });

  it('filters by section prefix', () => {
    const hits = searchVault(index, {
      query: 'moltbank',
      section: 'wiki/overview',
      limit: 50,
      callerMax: 'secret',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.path.startsWith('wiki/overview/'))).toBe(true);
  });

  it('filters by status', () => {
    const hits = searchVault(index, {
      query: 'stub',
      status: 'stub',
      limit: 50,
      callerMax: 'secret',
    });
    // Every returned hit is actually stub
    for (const h of hits) {
      const file = index.files.get(h.path);
      expect(file?.frontmatter.status).toBe('stub');
    }
  });

  it('returns empty for empty query', () => {
    const hits = searchVault(index, { query: '   ', limit: 10, callerMax: 'secret' });
    expect(hits).toEqual([]);
  });
});
