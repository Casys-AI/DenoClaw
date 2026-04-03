import * as stdLog from "@std/log";

// ── Map env LOG_LEVEL to @std/log level names ──
const ENV_TO_LEVEL: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

const envLevel = Deno.env.get("LOG_LEVEL") ?? "info";
const levelName = ENV_TO_LEVEL[envLevel] ?? "INFO";

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return " " + args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
}

function formatRecord(record: stdLog.LogRecord): string {
  const ts = record.datetime.toISOString().slice(11, 19);
  return `${ts} [${record.levelName}] ${record.msg}${formatArgs(record.args)}`;
}

// ── Console handler with compact timestamp ──
const consoleHandler = new stdLog.ConsoleHandler(levelName as stdLog.LevelName, {
  formatter: formatRecord,
  useColors: true,
});

// ── Optional file handler ──
const logFile = Deno.env.get("LOG_FILE");
const handlers: Record<string, stdLog.BaseHandler> = { console: consoleHandler };

if (logFile) {
  handlers.file = new stdLog.FileHandler(levelName as stdLog.LevelName, {
    filename: logFile,
    formatter: formatRecord,
  });
}

stdLog.setup({
  handlers,
  loggers: {
    default: {
      level: levelName as stdLog.LevelName,
      handlers: logFile ? ["console", "file"] : ["console"],
    },
  },
});

const logger = stdLog.getLogger();

// ── Backward-compatible API — same signature as before ──
export const log = {
  debug(msg: string, data?: unknown) {
    if (data !== undefined) {
      logger.debug(msg, data);
    } else {
      logger.debug(msg);
    }
  },
  info(msg: string, data?: unknown) {
    if (data !== undefined) {
      logger.info(msg, data);
    } else {
      logger.info(msg);
    }
  },
  warn(msg: string, data?: unknown) {
    if (data !== undefined) {
      logger.warn(msg, data);
    } else {
      logger.warn(msg);
    }
  },
  error(msg: string, data?: unknown) {
    if (data !== undefined) {
      logger.error(msg, data);
    } else {
      logger.error(msg);
    }
  },
};
