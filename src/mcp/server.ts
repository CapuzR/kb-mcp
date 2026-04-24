import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResolvedCaller } from '../auth/tokens';
import { registerVaultSearch } from './tools/vault-search';
import { registerVaultReadFile } from './tools/vault-read-file';
import { registerVaultListSection } from './tools/vault-list-section';
import { registerVaultGetStatus } from './tools/vault-get-status';
import { registerVaultSearchTodos } from './tools/vault-search-todos';
import { registerVaultListAutoSynced } from './tools/vault-list-auto-synced';
import { registerVaultGetAssetIndex } from './tools/vault-get-asset-index';
import { registerTempProposeChange } from './tools/temp-propose-change';
import { registerTempListMyEntries } from './tools/temp-list-my-entries';
import { registerOperationsGa4Query } from './tools/operations-ga4-query';
import {
  registerOperationsLinearSearch,
  registerOperationsLinearGet,
  registerOperationsLinearCreate,
  registerOperationsLinearUpdate,
} from './tools/operations-linear';

/**
 * Build a fresh MCP server bound to a specific caller. Stateless per HTTP
 * request: we capture the caller's consumer config in each tool closure so
 * we can cleanly authorize without relying on cross-cutting state.
 *
 * Tool families:
 *   vault_*       — read-only vault access, gated by max_visibility.
 *   temp_*        — write path into temp/<owner>.md, gated by caller.owner.
 *   operations_*  — ops integrations (GA4, Linear), gated by caller.operations.*.
 *
 * Write- and operations-family tools are only registered if the caller's
 * token has the corresponding scope, so `tools/list` responses reveal only
 * what the caller can actually call.
 */
export function buildMcpServerForCaller(caller: ResolvedCaller): McpServer {
  const server = new McpServer(
    {
      name: 'moltbank-kb-mcp',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Access the moltbank-kb knowledge vault (read), propose changes via temp/<owner>.md (write), and query ops systems (GA4, Linear). Use vault_search for discovery, vault_read_file to read, temp_propose_change to submit a proposal, and operations_* for live ops data.',
    }
  );

  // Read tools — always available.
  registerVaultSearch(server, caller);
  registerVaultReadFile(server, caller);
  registerVaultListSection(server, caller);
  registerVaultGetStatus(server, caller);
  registerVaultSearchTodos(server, caller);
  registerVaultListAutoSynced(server, caller);
  registerVaultGetAssetIndex(server, caller);

  // Temp write tools — only for tokens with an `owner` field.
  if (caller.consumer.owner) {
    registerTempProposeChange(server, caller);
    registerTempListMyEntries(server, caller);
  }

  // Operations tools — only for tokens with the matching operations.* scope.
  if (caller.consumer.operations?.ga4) {
    registerOperationsGa4Query(server, caller);
  }
  if (caller.consumer.operations?.linear_read || caller.consumer.operations?.linear_write) {
    registerOperationsLinearSearch(server, caller);
    registerOperationsLinearGet(server, caller);
  }
  if (caller.consumer.operations?.linear_write) {
    registerOperationsLinearCreate(server, caller);
    registerOperationsLinearUpdate(server, caller);
  }

  return server;
}
