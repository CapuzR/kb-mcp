/**
 * Error codes we surface through the MCP layer. These map to McpError codes or
 * application-specific error data.
 */
export const ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found',
  INVALID_INPUT: 'invalid_input',
  PATH_TRAVERSAL: 'path_traversal',
  INTERNAL: 'internal',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(ERROR_CODES.NOT_FOUND, message, 404);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(ERROR_CODES.FORBIDDEN, message, 403);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(ERROR_CODES.UNAUTHORIZED, message, 401);
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = 'Rate limit exceeded') {
    super(ERROR_CODES.RATE_LIMITED, message, 429);
    this.retryAfterMs = retryAfterMs;
  }
}

export class PathTraversalError extends AppError {
  constructor(message = 'Path traversal not allowed') {
    super(ERROR_CODES.PATH_TRAVERSAL, message, 400);
  }
}
