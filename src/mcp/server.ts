import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResolvedCaller } from '../auth/tokens';
import { registerVaultSearch } from './tools/vault-search';
import { registerVaultReadFile } from './tools/vault-read-file';
import { registerVaultListSection } from './tools/vault-list-section';
import { registerVaultGetStatus } from './tools/vault-get-status';
import { registerVaultSearchTodos } from './tools/vault-search-todos';
import { registerVaultListAutoSynced } from './tools/vault-list-auto-synced';
import { registerVaultGetAssetIndex } from './tools/vault-get-asset-index';

/**
 * Build a fresh MCP server bound to a specific caller. Stateless per HTTP
 * request: we capture the caller's consumer config in each tool closure so
 * we can cleanly authorize without relying on cross-cutting state.
 */
export function buildMcpServerForCaller(caller: ResolvedCaller): McpServer {
  const server = new McpServer(
    {
      name: 'moltbank-kb-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Access the moltbank-kb knowledge vault. Use vault_search to find files, vault_read_file to read them, and vault_get_status for coverage.',
    }
  );

  registerVaultSearch(server, caller);
  registerVaultReadFile(server, caller);
  registerVaultListSection(server, caller);
  registerVaultGetStatus(server, caller);
  registerVaultSearchTodos(server, caller);
  registerVaultListAutoSynced(server, caller);
  registerVaultGetAssetIndex(server, caller);

  return server;
}
