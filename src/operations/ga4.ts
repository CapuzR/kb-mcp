/**
 * Google Analytics 4 client wrapper.
 *
 * This module is a thin layer over the `@google-analytics/data` SDK.
 * Lazy-imported so kb-mcp builds without the dep installed; only pulled
 * in at tool-call time. The tool layer is responsible for caller scope
 * (`operations.ga4 === true`); this file only does the network call.
 *
 * Env vars required:
 *   GA4_PROPERTY_ID         — numeric property ID (e.g. 529850183)
 *   GA4_SERVICE_ACCOUNT_KEY — service account JSON (single line or multi)
 *
 * Status: scaffold. Ship the dep + service account, then this module
 * becomes the only thing to update to enable the tool.
 */

import { AppError } from '../errors';

export interface Ga4QueryInput {
  date_range: { start_date: string; end_date: string };
  metrics: string[];
  dimensions?: string[];
  row_limit?: number;
}

export interface Ga4QueryResult {
  rows: Array<Record<string, string | number>>;
  totals: Record<string, number>;
  property_id: string;
}

function loadServiceAccountKey(): object {
  const raw = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new AppError('internal', 'GA4_SERVICE_ACCOUNT_KEY is not set', 500);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AppError(
      'internal',
      `GA4_SERVICE_ACCOUNT_KEY is not valid JSON: ${(err as Error).message}`,
      500
    );
  }
}

function propertyId(): string {
  const id = process.env.GA4_PROPERTY_ID;
  if (!id) throw new AppError('internal', 'GA4_PROPERTY_ID is not set', 500);
  return id;
}

export async function runGa4Report(input: Ga4QueryInput): Promise<Ga4QueryResult> {
  // Lazy import so the dep is optional at build time. Install
  // `@google-analytics/data` before enabling the operations_ga4_query tool.
  // Typed as `any` on purpose — the SDK types are only meaningful once the
  // dep is installed, and this module is a thin pass-through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@google-analytics/data').catch(() => {
    throw new AppError(
      'internal',
      '@google-analytics/data is not installed; add it to package.json before calling operations_ga4_query',
      500
    );
  });
  const BetaAnalyticsDataClient = mod.BetaAnalyticsDataClient;

  const credentials = loadServiceAccountKey() as {
    client_email?: string;
    private_key?: string;
  };
  if (!credentials.client_email || !credentials.private_key) {
    throw new AppError(
      'internal',
      'GA4_SERVICE_ACCOUNT_KEY missing client_email or private_key',
      500
    );
  }
  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key.replace(/\\n/g, '\n'),
    },
  });

  const property = `properties/${propertyId()}`;
  const [report] = await client.runReport({
    property,
    dateRanges: [input.date_range],
    metrics: input.metrics.map((m: string) => ({ name: m })),
    dimensions: (input.dimensions ?? []).map((d: string) => ({ name: d })),
    limit: input.row_limit ? String(input.row_limit) : undefined,
  });

  const rows: Array<Record<string, string | number>> = [];
  const dimHeaders: Array<{ name?: string }> = report.dimensionHeaders ?? [];
  const metHeaders: Array<{ name?: string }> = report.metricHeaders ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (report.rows ?? []) as any[]) {
    const entry: Record<string, string | number> = {};
    dimHeaders.forEach((h, i) => {
      entry[h.name ?? `dim_${i}`] = row.dimensionValues?.[i]?.value ?? '';
    });
    metHeaders.forEach((h, i) => {
      const raw = row.metricValues?.[i]?.value ?? '0';
      const num = Number(raw);
      entry[h.name ?? `metric_${i}`] = Number.isFinite(num) ? num : raw;
    });
    rows.push(entry);
  }
  const totals: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of (report.totals ?? []) as any[]) {
    metHeaders.forEach((h, i) => {
      if (!h.name) return;
      const raw = t.metricValues?.[i]?.value ?? '0';
      totals[h.name] = Number(raw) || 0;
    });
  }

  return { rows, totals, property_id: propertyId() };
}
