/** Minimal leveled logger. Every line is passed through `redact` so secrets never reach the logs. */
import { redactSecrets } from '@orch/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Masks agent credentials and Claude / GitHub tokens (the shared list, also used server-side). */
export function redact(text: string): string {
  return redactSecrets(text);
}

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (l) => process.stdout.write(l),
): Logger {
  const min = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Fields) => {
    if (ORDER[lvl] < min) return;
    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    write(redact(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}${extra}`) + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent');

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
