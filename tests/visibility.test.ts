import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestIndex } from './helpers/build-test-index';
import { callerCanSee, filterByVisibility } from '../src/vault/visibility';
import { VaultIndex } from '../src/vault/types';

let index: VaultIndex;
beforeAll(async () => {
  index = await buildTestIndex();
});

describe('callerCanSee', () => {
  it('public tier sees only public', () => {
    expect(callerCanSee('public', 'public')).toBe(true);
    expect(callerCanSee('public', 'internal')).toBe(false);
    expect(callerCanSee('public', 'secret')).toBe(false);
  });
  it('internal tier sees public + internal', () => {
    expect(callerCanSee('internal', 'public')).toBe(true);
    expect(callerCanSee('internal', 'internal')).toBe(true);
    expect(callerCanSee('internal', 'secret')).toBe(false);
  });
  it('secret tier sees everything', () => {
    expect(callerCanSee('secret', 'public')).toBe(true);
    expect(callerCanSee('secret', 'internal')).toBe(true);
    expect(callerCanSee('secret', 'secret')).toBe(true);
  });
});

describe('filterByVisibility', () => {
  it('public token hides internal and secret', () => {
    const all = [...index.files.values()];
    const filtered = filterByVisibility(all, 'public');
    const tiers = new Set(filtered.map(f => f.frontmatter.visibility));
    expect(tiers.has('public')).toBe(true);
    expect(tiers.has('internal')).toBe(false);
    expect(tiers.has('secret')).toBe(false);
  });

  it('internal token hides secret', () => {
    const all = [...index.files.values()];
    const filtered = filterByVisibility(all, 'internal');
    const tiers = new Set(filtered.map(f => f.frontmatter.visibility));
    expect(tiers.has('secret')).toBe(false);
    expect(tiers.has('internal')).toBe(true);
  });

  it('secret token sees everything including treasury', () => {
    const all = [...index.files.values()];
    const filtered = filterByVisibility(all, 'secret');
    expect(filtered.some(f => f.path === 'wiki/finance/treasury.md')).toBe(true);
  });
});
