interface LogContext {
  jobId?: string;
  stage?: string;
  [key: string]: unknown;
}

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  context: LogContext;
}

function formatLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export function createLogger(jobId?: string) {
  const baseContext: LogContext = jobId ? { jobId } : {};

  return {
    debug(message: string, context: LogContext = {}) {
      console.debug(formatLogEntry({
        level: "debug",
        message,
        timestamp: new Date().toISOString(),
        context: { ...baseContext, ...context },
      }));
    },
    info(message: string, context: LogContext = {}) {
      console.log(formatLogEntry({
        level: "info",
        message,
        timestamp: new Date().toISOString(),
        context: { ...baseContext, ...context },
      }));
    },
    warn(message: string, context: LogContext = {}) {
      console.warn(formatLogEntry({
        level: "warn",
        message,
        timestamp: new Date().toISOString(),
        context: { ...baseContext, ...context },
      }));
    },
    error(message: string, context: LogContext = {}) {
      console.error(formatLogEntry({
        level: "error",
        message,
        timestamp: new Date().toISOString(),
        context: { ...baseContext, ...context },
      }));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
