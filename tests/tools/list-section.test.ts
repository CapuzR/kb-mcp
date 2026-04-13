import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestIndex } from '../helpers/build-test-index';
import { listSection } from '../../src/vault/index';
import { filterByVisibility } from '../../src/vault/visibility';
import { VaultIndex } from '../../src/vault/types';

let index: VaultIndex;
beforeAll(async () => {
  index = await buildTestIndex();
});

describe('listSection', () => {
  it('lists descendants recursively by default', () => {
    const files = listSection(index, 'wiki', true);
    expect(files.some(f => f.path === 'wiki/overview/what-is-moltbank.md')).toBe(true);
    expect(files.some(f => f.path === 'wiki/finance/treasury.md')).toBe(true);
  });

  it('non-recursive lists only direct children', () => {
    const files = listSection(index, 'wiki/overview', false);
    expect(files.every(f => !f.path.slice('wiki/overview/'.length).includes('/'))).toBe(true);
  });

  it('applies visibility filter so public token never sees internal or secret', () => {
    const all = listSection(index, 'wiki', true);
    const publicOnly = filterByVisibility(all, 'public');
    expect(publicOnly.some(f => f.path === 'wiki/finance/treasury.md')).toBe(false);
    expect(publicOnly.some(f => f.path === 'wiki/product/feature-roadmap.md')).toBe(false);
    // But does include the public items
    expect(publicOnly.some(f => f.path === 'wiki/overview/what-is-moltbank.md')).toBe(true);
  });

  it('empty for a section with no matches', () => {
    const files = listSection(index, 'does/not/exist', true);
    expect(files).toEqual([]);
  });
});
