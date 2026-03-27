const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel = (Deno.env.get("LOG_LEVEL") as LogLevel) ||
  "info";
const threshold = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info;

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  debug(msg: string, data?: unknown) {
    if (threshold <= LOG_LEVELS.debug) {
      console.debug(`%c${ts()} [DBG] ${msg}`, "color: gray", data ?? "");
    }
  },
  info(msg: string, data?: unknown) {
    if (threshold <= LOG_LEVELS.info) {
      console.info(`${ts()} [INF] ${msg}`, data !== undefined ? data : "");
    }
  },
  warn(msg: string, data?: unknown) {
    if (threshold <= LOG_LEVELS.warn) {
      console.warn(`${ts()} [WRN] ${msg}`, data !== undefined ? data : "");
    }
  },
  error(msg: string, data?: unknown) {
    if (threshold <= LOG_LEVELS.error) {
      console.error(`${ts()} [ERR] ${msg}`, data !== undefined ? data : "");
    }
  },
};
