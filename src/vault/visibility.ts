import { VISIBILITY_TIERS, Visibility, VaultFile } from './types';

const RANK: Record<Visibility, number> = {
  public: 0,
  internal: 1,
  secret: 2,
};

export function visibilityRank(v: Visibility): number {
  return RANK[v];
}

export function isVisibilityTier(v: unknown): v is Visibility {
  return typeof v === 'string' && (VISIBILITY_TIERS as readonly string[]).includes(v);
}

/**
 * True iff a caller with `callerMax` is allowed to see files marked `fileTier`.
 */
export function callerCanSee(callerMax: Visibility, fileTier: Visibility): boolean {
  return RANK[fileTier] <= RANK[callerMax];
}

/**
 * Filter a list of files down to what the caller is permitted to see.
 */
export function filterByVisibility<T extends Pick<VaultFile, 'frontmatter'>>(
  files: readonly T[],
  callerMax: Visibility
): T[] {
  return files.filter(f => callerCanSee(callerMax, f.frontmatter.visibility));
}
