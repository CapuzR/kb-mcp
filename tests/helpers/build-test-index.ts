import path from 'node:path';
import { buildIndex } from '../../src/vault/index';
import { VaultIndex } from '../../src/vault/types';

export const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'mini-vault');

export async function buildTestIndex(): Promise<VaultIndex> {
  return buildIndex(FIXTURE_ROOT, 'fixture-sha-0001');
}

export const TEST_MCP_TOKENS = JSON.stringify({
  tok_public: { name: 'public-wiki-preview', max_visibility: 'public', rate_limit_per_min: 30 },
  tok_internal: { name: 'paperclip-prod', max_visibility: 'internal', rate_limit_per_min: 60 },
  tok_secret: { name: 'cap-admin', max_visibility: 'secret', rate_limit_per_min: 300 },
  tok_limited: { name: 'rate-test', max_visibility: 'internal', rate_limit_per_min: 2 },
});
