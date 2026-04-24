import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ResolvedCaller } from '../../auth/tokens';
import { runGa4Report } from '../../operations/ga4';
import { ForbiddenError, AppError } from '../../errors';
import { logToolCall } from '../../logging';

const inputShape = {
  date_range: z
    .object({
      start_date: z.string().describe("Start date ('YYYY-MM-DD' or 'NdaysAgo')."),
      end_date: z.string().describe("End date ('YYYY-MM-DD' or 'today')."),
    })
    .describe('GA4 date range.'),
  metrics: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe("GA4 metric names, e.g. ['activeUsers','sessions','screenPageViews']."),
  dimensions: z
    .array(z.string().min(1))
    .max(9)
    .optional()
    .describe("GA4 dimension names, e.g. ['date','pagePath','sessionSource']."),
  row_limit: z.number().int().min(1).max(1000).optional().describe('Max rows (default 100).'),
};

export function registerOperationsGa4Query(server: McpServer, caller: ResolvedCaller): void {
  server.registerTool(
    'operations_ga4_query',
    {
      title: 'Query Google Analytics 4',
      description:
        'Run a GA4 report over moltbank.bot analytics (property 529850183). Requires operations.ga4 scope.',
      inputSchema: inputShape,
    },
    async ({ date_range, metrics, dimensions, row_limit }): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        if (!caller.consumer.operations?.ga4) {
          throw new ForbiddenError(
            'operations_ga4_query requires the operations.ga4 scope on your token'
          );
        }
        const result = await runGa4Report({
          date_range,
          metrics,
          dimensions,
          row_limit,
        });

        const out = JSON.stringify(result);
        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'operations_ga4_query',
          input_size: JSON.stringify({ date_range, metrics, dimensions }).length,
          output_size: out.length,
          result_count: result.rows.length,
          status: 'ok',
          duration_ms: Date.now() - started,
        });
        return {
          content: [{ type: 'text', text: out }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'internal';
        logToolCall({
          event: 'tool_call',
          ts: new Date().toISOString(),
          consumer: caller.consumer.name,
          tool: 'operations_ga4_query',
          status: 'error',
          error_code: code,
          duration_ms: Date.now() - started,
        });
        if (err instanceof AppError || err instanceof ForbiddenError) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );
}
