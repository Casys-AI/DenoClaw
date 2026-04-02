import { log } from "../shared/log.ts";

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export class AnalyticsWriteScheduler {
  #consecutiveFailures = 0;
  #disabled = false;

  constructor(
    private readonly maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  ) {}

  schedule(operation: string, write: () => Promise<void>): void {
    if (this.#disabled) return;

    void write()
      .then(() => {
        if (!this.#disabled) {
          this.#consecutiveFailures = 0;
        }
      })
      .catch((error) => {
        if (this.#disabled) return;

        this.#consecutiveFailures += 1;
        const details = {
          operation,
          consecutiveFailures: this.#consecutiveFailures,
          maxConsecutiveFailures: this.maxConsecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        };

        if (this.#consecutiveFailures >= this.maxConsecutiveFailures) {
          this.#disabled = true;
          log.error(
            "analytics: disabling async writes after repeated failures",
            details,
          );
          return;
        }

        log.warn(`analytics: failed to ${operation}`, details);
      });
  }

  resetForTest(): void {
    this.#consecutiveFailures = 0;
    this.#disabled = false;
  }
}

const defaultAnalyticsWriteScheduler = new AnalyticsWriteScheduler();

export function scheduleAnalyticsWrite(
  operation: string,
  write: () => Promise<void>,
): void {
  defaultAnalyticsWriteScheduler.schedule(operation, write);
}

export function resetDefaultAnalyticsWriteSchedulerForTest(): void {
  defaultAnalyticsWriteScheduler.resetForTest();
}
