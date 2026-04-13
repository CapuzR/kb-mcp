import { Status, VaultFile, VaultIndex, Visibility } from './types';
import { callerCanSee } from './visibility';

export interface SearchOptions {
  query: string;
  section?: string;
  status?: Status;
  limit: number;
  callerMax: Visibility;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  status: Status | null;
  coverage: string | number | null;
  visibility: Visibility;
  match_score: number;
}

const TITLE_WEIGHT = 100;
const HEADING_WEIGHT = 25;
const BODY_WEIGHT = 5;
const MAX_SNIPPET = 240;

/**
 * Tokenize a query into lowercased words. Punctuation stripped, empties dropped.
 */
function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(t => t.length > 1);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Extract all markdown headings (lines starting with `#`) from body. */
function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  const re = /^\s*#{1,6}\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    headings.push(m[1].toLowerCase());
  }
  return headings;
}

/** Build a ~MAX_SNIPPET-char snippet around the first match of `phrase` in body. */
function buildSnippet(body: string, bodyLower: string, phrase: string): string {
  if (!phrase) return body.slice(0, MAX_SNIPPET).replace(/\s+/g, ' ').trim();
  const hit = bodyLower.indexOf(phrase.toLowerCase());
  if (hit === -1) {
    return body.slice(0, MAX_SNIPPET).replace(/\s+/g, ' ').trim();
  }
  const half = Math.floor(MAX_SNIPPET / 2);
  const start = Math.max(0, hit - half);
  const end = Math.min(body.length, hit + half);
  return (start > 0 ? '… ' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? ' …' : '');
}

interface Scored {
  file: VaultFile;
  score: number;
}

/**
 * Search the indexed vault. Visibility filtering happens *inside* this
 * function (not as a post-filter) so we never score files we aren't allowed
 * to surface.
 */
export function searchVault(index: VaultIndex, opts: SearchOptions): SearchHit[] {
  const phrase = opts.query.trim();
  const phraseLower = phrase.toLowerCase();
  const tokens = tokenize(phrase);
  if (!phrase || tokens.length === 0) return [];

  const sectionPrefix = opts.section?.replace(/\\/g, '/').replace(/\/+$/, '') ?? null;

  const scored: Scored[] = [];
  for (const file of index.files.values()) {
    // visibility first
    if (!callerCanSee(opts.callerMax, file.frontmatter.visibility)) continue;
    // section filter
    if (sectionPrefix) {
      if (file.path !== sectionPrefix && !file.path.startsWith(sectionPrefix + '/')) continue;
    }
    // status filter
    if (opts.status && file.frontmatter.status !== opts.status) continue;

    const titleLower = file.title.toLowerCase();
    const headings = extractHeadings(file.body);
    const body = file.bodyLower;

    let score = 0;

    // exact phrase hits
    score += countOccurrences(titleLower, phraseLower) * TITLE_WEIGHT;
    for (const h of headings) score += countOccurrences(h, phraseLower) * HEADING_WEIGHT;
    score += countOccurrences(body, phraseLower) * BODY_WEIGHT;

    // per-token hits (cover cases where query words are split)
    for (const tok of tokens) {
      if (titleLower.includes(tok)) score += TITLE_WEIGHT / 2;
      for (const h of headings) if (h.includes(tok)) score += HEADING_WEIGHT / 2;
      score += countOccurrences(body, tok);
    }

    if (score > 0) scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const top = scored.slice(0, Math.max(0, opts.limit));
  return top.map(({ file, score }) => ({
    path: file.path,
    title: file.title,
    snippet: buildSnippet(file.body, file.bodyLower, phraseLower),
    status: file.frontmatter.status ?? null,
    coverage: file.frontmatter.coverage ?? null,
    visibility: file.frontmatter.visibility,
    match_score: score,
  }));
}
