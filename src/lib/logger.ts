import pino, { type LoggerOptions } from "pino";

export function loggerOptions(level: string): LoggerOptions {
  if (process.env.NODE_ENV === "production") {
    return { level };
  }
  return {
    level,
    transport: { target: "pino-pretty", options: { colorize: true } },
  };
}

export function createLogger(level: string) {
  return pino(loggerOptions(level));
}

export type Logger = ReturnType<typeof createLogger>;
