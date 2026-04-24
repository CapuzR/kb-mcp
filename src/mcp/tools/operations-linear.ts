import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import {
  searchLinearIssues,
  getLinearIssue,
  createLinearIssue,
  updateLinearIssue,
} from '../../operations/linear';
import { ForbiddenError, AppError } from '../../errors';
import { logToolCall } from '../../logging';

// --- search -------------------------------------------------------------

const searchInputShape = {
  query: z.string().min(1).optional().describe('Free-text search against title + description.'),
  team_key: z.string().optional().describe('Linear team key, e.g. "MLT".'),
  state: z
    .enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])
    .optional()
    .describe('Filter by Linear state type.'),
  assignee: z.string().optional().describe('Linear user name or id.'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
};

export function registerOperationsLinearSearch(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'operations_linear_search_issues',
    {
      title: 'Search Linear issues',
      description:
        'Search Linear issues across the workspace. Requires operations.linear_read scope.',
      inputSchema: searchInputShape,
    },
    async (input): Promise<CallToolResult> => wrap('operations_linear_search_issues', caller, input, async () => {
      requireLinearRead(caller);
      const issues = await searchLinearIssues(input);
      return { issues };
    })
  );
}

// --- get single issue ---------------------------------------------------

const getInputShape = {
  identifier: z.string().min(1).describe('Linear issue identifier, e.g. "MLT-42".'),
};

export function registerOperationsLinearGet(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'operations_linear_get_issue',
    {
      title: 'Get a Linear issue',
      description:
        'Fetch a single Linear issue with description, labels, and comments. Requires operations.linear_read scope.',
      inputSchema: getInputShape,
    },
    async ({ identifier }): Promise<CallToolResult> =>
      wrap('operations_linear_get_issue', caller, { identifier }, async () => {
        requireLinearRead(caller);
        const issue = await getLinearIssue(identifier);
        return { issue };
      })
  );
}

// --- create -------------------------------------------------------------

const createInputShape = {
  team_key: z.string().min(1).describe('Linear team key, e.g. "MLT".'),
  title: z.string().min(1).max(300).describe('Issue title.'),
  description: z.string().max(32_000).optional().describe('Issue description (markdown).'),
  assignee: z.string().optional().describe('Linear user name or id to assign.'),
  labels: z.array(z.string().min(1)).max(20).optional().describe('Label names.'),
  priority: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional()
    .describe('0=no priority, 1=urgent, 2=high, 3=medium, 4=low.'),
  project: z.string().optional().describe('Project id or name.'),
};

export function registerOperationsLinearCreate(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'operations_linear_create_issue',
    {
      title: 'Create a Linear issue',
      description:
        'Create a new Linear issue. Requires operations.linear_write scope.',
      inputSchema: createInputShape,
    },
    async (input): Promise<CallToolResult> => wrap('operations_linear_create_issue', caller, input, async () => {
      requireLinearWrite(caller);
      const created = await createLinearIssue(input);
      return created;
    })
  );
}

// --- update -------------------------------------------------------------

const updateInputShape = {
  identifier: z.string().min(1).describe('Linear issue identifier, e.g. "MLT-42".'),
  state: z.string().optional().describe('Target state name (e.g. "In Progress", "Done").'),
  assignee: z.string().optional().describe('Linear user name or id.'),
  priority: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional(),
  comment: z.string().max(32_000).optional().describe('Comment body (markdown).'),
};

export function registerOperationsLinearUpdate(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'operations_linear_update_issue',
    {
      title: 'Update a Linear issue',
      description:
        'Update state, assignee, priority, or add a comment on a Linear issue. Requires operations.linear_write scope.',
      inputSchema: updateInputShape,
    },
    async (input): Promise<CallToolResult> =>
      wrap('operations_linear_update_issue', caller, input, async () => {
        requireLinearWrite(caller);
        const result = await updateLinearIssue(input);
        return result;
      })
  );
}

// --- helpers ------------------------------------------------------------

function requireLinearRead(caller: ResolvedCaller): void {
  if (!caller.consumer.operations?.linear_read) {
    throw new ForbiddenError('requires operations.linear_read scope on your token');
  }
}

function requireLinearWrite(caller: ResolvedCaller): void {
  if (!caller.consumer.operations?.linear_write) {
    throw new ForbiddenError('requires operations.linear_write scope on your token');
  }
}

async function wrap<T>(
  tool: string,
  caller: ResolvedCaller,
  input: unknown,
  body: () => Promise<T>
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await body();
    const out = JSON.stringify(result);
    logToolCall({
      event: 'tool_call',
      ts: new Date().toISOString(),
      consumer: caller.consumer.name,
      tool,
      input_size: JSON.stringify(input).length,
      output_size: out.length,
      status: 'ok',
      duration_ms: Date.now() - started,
    });
    return {
      content: [{ type: 'text', text: out }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal';
    logToolCall({
      event: 'tool_call',
      ts: new Date().toISOString(),
      consumer: caller.consumer.name,
      tool,
      status: 'error',
      error_code: code,
      duration_ms: Date.now() - started,
    });
    if (err instanceof AppError || err instanceof ForbiddenError) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    throw err;
  }
}
