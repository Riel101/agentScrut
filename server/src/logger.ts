/* A tiny dependency-free structured logger. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ??
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (levelRank[level] < levelRank[configuredLevel]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ?? {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
  /** Adapter for the SDK's `logger` option. */
  sdk: {
    debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
    warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  },
};

export type Logger = typeof logger;
