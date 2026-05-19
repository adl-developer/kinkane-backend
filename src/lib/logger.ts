type Level = 'debug' | 'info' | 'warn' | 'error';
type Context = Record<string, unknown>;

function write(level: Level, message: string, context?: Context): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const line = JSON.stringify(entry) + '\n';
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (message: string, context?: Context) => write('debug', message, context),
  info:  (message: string, context?: Context) => write('info',  message, context),
  warn:  (message: string, context?: Context) => write('warn',  message, context),
  error: (message: string, context?: Context) => write('error', message, context),
};
