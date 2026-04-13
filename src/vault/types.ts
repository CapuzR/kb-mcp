/**
 * Visibility tiers, from least to most privileged.
 * A caller with tier X can see any file whose tier rank is <= X's rank.
 */
export const VISIBILITY_TIERS = ['public', 'internal', 'secret'] as const;
export type Visibility = (typeof VISIBILITY_TIERS)[number];

export const STATUS_VALUES = ['complete', 'partial', 'stub'] as const;
export type Status = (typeof STATUS_VALUES)[number];

/**
 * Frontmatter shape for every markdown file in the vault. We are generous in
 * what we accept (unknown fields are preserved on `raw`) but strict about
 * the few fields our tools actually key on.
 */
export interface Frontmatter {
  title?: string;
  status?: Status;
  coverage?: string | number;
  visibility: Visibility;
  maintained_by?: string;
  last_updated?: string;
  // auto-synced metadata
  source_repo?: string;
  source_paths?: string[];
  cadence?: string;
  last_synced?: string | null;
  // related links
  related?: string[];
  // section tag (free-form)
  section?: string;
  // everything else — preserved but not typed
  [key: string]: unknown;
}

export interface VaultFile {
  /** path relative to the vault root, always forward-slash, e.g. "wiki/overview/foo.md" */
  path: string;
  /** first heading or frontmatter.title, whichever is present; falls back to filename */
  title: string;
  frontmatter: Frontmatter;
  /** markdown body with the frontmatter block stripped */
  body: string;
  /** cached lowercased body for substring search */
  bodyLower: string;
}

export interface VaultIndex {
  /** git sha the index was built from */
  sha: string;
  /** absolute path on disk to the vault root */
  rootPath: string;
  /** map of path → file */
  files: Map<string, VaultFile>;
  /** unix ms when the index was last built */
  builtAt: number;
}
