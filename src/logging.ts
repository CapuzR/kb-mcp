/**
 * Minimal structured logger. Writes JSON lines to stdout. We never log file
 * bodies or tokens — callers must only pass the handful of safe fields below.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

/**
 * Safe fields allowed in tool-call log records. Explicit to keep us from
 * accidentally logging secrets or bodies.
 */
export interface ToolCallLog {
  event: 'tool_call';
  ts: string;
  consumer: string;
  tool: string;
  /** approx size of input JSON (chars) */
  input_size?: number;
  /** approx size of output JSON (chars) */
  output_size?: number;
  /** if the tool operates on a single path, record it — never a body */
  path?: string;
  /** if the tool returns a collection, how many items */
  result_count?: number;
  /** outcome of the call */
  status: 'ok' | 'error';
  error_code?: string;
  duration_ms: number;
}

export interface GenericLog {
  event: string;
  ts: string;
  [key: string]: unknown;
}

function shouldEmit(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel()];
}

function write(level: Level, record: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  const line = JSON.stringify({ level, ...record });
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logDebug(record: GenericLog): void {
  write('debug', record);
}

export function logInfo(record: GenericLog): void {
  write('info', record);
}

export function logWarn(record: GenericLog): void {
  write('warn', record);
}

export function logError(record: GenericLog): void {
  write('error', record);
}

export function logToolCall(record: ToolCallLog): void {
  write('info', { ...record });
}

/**
 * Redact anything that looks like a bearer token or PEM chunk from arbitrary
 * text. Defense-in-depth only — the first line of defense is not logging
 * those fields at all.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-.=]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted PEM]');
}
