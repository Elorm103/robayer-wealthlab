/**
 * Structured JSON logging, per docs/monitoring-and-alerting.md: every
 * log line is one JSON object shaped { timestamp, requestId, route,
 * level, message, context }, so Cloudflare's log viewer (and `wrangler
 * tail`) can filter/grep by any of those fields instead of parsing
 * free text.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

function emit(
  level: LogLevel,
  requestId: string,
  route: string,
  message: string,
  context?: LogContext
): void {
  const line = {
    timestamp: new Date().toISOString(),
    requestId,
    route,
    level,
    message,
    ...(context ? { context } : {}),
  };
  const serialized = JSON.stringify(line);

  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

/** Binds a logger to one request's requestId/route so every call site doesn't have to repeat both on every call. */
export function createLogger(requestId: string, route: string): Logger {
  return {
    info: (message, context) => emit('info', requestId, route, message, context),
    warn: (message, context) => emit('warn', requestId, route, message, context),
    error: (message, context) => emit('error', requestId, route, message, context),
  };
}
